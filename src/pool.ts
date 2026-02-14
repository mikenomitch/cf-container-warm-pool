import { DurableObject } from 'cloudflare:workers';
import type {
  PoolConfigInternal,
  PoolStats,
} from './types.js';

const DEFAULT_CONFIG: Required<PoolConfigInternal> = {
  warmTarget: 5,
  refreshInterval: 10 * 1000, // 10 seconds
};

/**
 * Interface for container methods we call via RPC
 */
interface ContainerRpc {
  startAndWaitForPorts(): Promise<void>;
  stop(signal?: string): Promise<void>;
  renewActivityTimeout(): void;
}

/**
 * State returned by Container.getState()
 * @see https://github.com/cloudflare/containers/blob/main/src/types/index.ts
 */
type ContainerState = {
  lastChange: number;
  status: 'running' | 'stopping' | 'stopped' | 'healthy' | 'stopped_with_code';
  exitCode?: number;
};

/**
 * Interface for checking container state via RPC.
 * The Container class from @cloudflare/containers exposes getState() by default.
 */
interface ContainerWithState {
  getState(): Promise<ContainerState>;
}

/**
 * WarmPool Durable Object - manages a pool of pre-warmed containers
 * 
 * Maintains warm containers ready for immediate use. When a user requests a container
 * by ID, they get a 1:1 mapping that persists. No sharing between user IDs.
 * 
 * All public methods are exposed as RPC calls.
 */
export class WarmPool<Env extends { CONTAINER: DurableObjectNamespace } = { CONTAINER: DurableObjectNamespace }> extends DurableObject<Env> {
  private config: Required<PoolConfigInternal> = DEFAULT_CONFIG;

  /** Container UUIDs that are warm and available for assignment */
  private warmContainers: Set<string> = new Set();

  /** Maps user-provided IDs to container UUIDs (1:1, no sharing) */
  private assignments: Map<string, string> = new Map();

  /** Containers currently starting — excluded from health checks to avoid false positives */
  private startingContainers: Set<string> = new Set();

  /** Inferred max_instances limit learned from Cloudflare errors, or `null` if unknown */
  private knownMaxInstances: number | null = null;

  private capacityExhausted = false;

  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // ===========================
  // Public RPC Methods
  // ===========================

  /**
   * Get a container UUID for the given user ID
   * - If this ID already has an assigned container and it's still running, return it
   * - Otherwise assign a warm container (or start a new one)
   */
  async getContainer(userID: string): Promise<string> {
    await this.init();

    const existingContainerUUID = this.assignments.get(userID);
    if (existingContainerUUID) {
      const running = await this.isContainerRunning(existingContainerUUID);
      if (running) {
        return existingContainerUUID;
      }
      this.assignments.delete(userID);
      await this.persist();
    }

    if (this.warmContainers.size > 0) {
      const containerUUID = this.warmContainers.values().next().value as string;
      this.warmContainers.delete(containerUUID);
      this.assignments.set(userID, containerUUID);
      await this.persist();
      return containerUUID;
    }

    if (this.remainingCapacity() <= 0) {
      const total = this.warmContainers.size + this.assignments.size;
      throw new Error(
        `Cannot start container: instance limit reached (${total}/${this.knownMaxInstances}). ` +
        `All container slots are in use. Wait for existing containers to stop.`
      );
    }

    const containerUUID = await this.startContainer();
    if (containerUUID) {
      this.assignments.set(userID, containerUUID);
      await this.persist();
      return containerUUID;
    }

    if (this.capacityExhausted) {
      const total = this.warmContainers.size + this.assignments.size;
      throw new Error(
        `Cannot start container: instance limit reached (${total}/${this.knownMaxInstances}). ` +
        `All container slots are in use. Wait for existing containers to stop.`
      );
    }

    throw new Error('Failed to start container');
  }

  /**
   * Report that a container has stopped - removes it from tracking.
   * Call this from your container's onStop() method.
   */
  async reportStopped(containerUUID: string): Promise<void> {
    await this.init();
    this.removeContainer(containerUUID);
    await this.persist();
  }

  /**
   * Get current pool statistics
   */
  async getStats(): Promise<PoolStats> {
    await this.init();

    return {
      warm: this.warmContainers.size,
      assigned: this.assignments.size,
      total: this.warmContainers.size + this.assignments.size,
      config: this.config,
      maxInstances: this.knownMaxInstances,
    };
  }

  /**
   * Update pool configuration
   */
  async configure(config: PoolConfigInternal): Promise<void> {
    await this.init();
    this.config = { ...DEFAULT_CONFIG, ...config };
    await this.ctx.storage.put('config', this.config);
  }

  /**
   * Shutdown all pre-warmed (unassigned) containers.
   * Does not affect containers that are assigned to user IDs.
   */
  async shutdownPrewarmed(): Promise<void> {
    await this.init();

    const containersToStop = [...this.warmContainers];

    for (const containerUUID of containersToStop) {
      try {
        const stub = this.getContainerStub(containerUUID);
        await (stub as unknown as ContainerRpc).stop();
        this.warmContainers.delete(containerUUID);
      } catch (error) {
        console.error(`Failed to stop container ${containerUUID}:`, error);
      }
    }

    await this.persist();
  }

  // ===========================
  // Alarm Handler
  // ===========================

  /**
   * Alarm handler - checks container health, adjusts pool size, and keeps warm containers alive
   */
  async alarm(): Promise<void> {
    await this.init();

    this.capacityExhausted = false;

    try {
      // Health-check all tracked containers and remove any that stopped.
      // This handles cases where onStop() failed to report.
      await this.checkContainerHealth();

      await this.adjustPool();
      await this.keepWarmContainersAlive();
    } catch (error) {
      console.error('Alarm handler error:', error);
    }

    await this.ctx.storage.setAlarm(Date.now() + this.config.refreshInterval);
  }

  /**
   * Renew activity timeout on all warm containers to prevent them from going stale
   */
  private async keepWarmContainersAlive(): Promise<void> {
    for (const containerUUID of this.warmContainers) {
      try {
        const stub = this.getContainerStub(containerUUID);
        (stub as unknown as ContainerRpc).renewActivityTimeout();
      } catch (error) {
        console.error(`Failed to renew activity timeout for ${containerUUID}:`, error);
      }
    }
  }

  // ===========================
  // Private Methods
  // ===========================

  /**
   * Initialize the pool - loads state from storage
   */
  private async init(): Promise<void> {
    if (this.initialized) return;

    const storedWarm = await this.ctx.storage.get<Set<string>>('warmContainers');
    if (storedWarm) {
      this.warmContainers = new Set(storedWarm);
    }

    const storedAssignments = await this.ctx.storage.get<Map<string, string>>('assignments');
    if (storedAssignments) {
      this.assignments = new Map(storedAssignments);
    }

    const storedConfig = await this.ctx.storage.get<PoolConfigInternal>('config');
    if (storedConfig) {
      this.config = { ...DEFAULT_CONFIG, ...storedConfig };
    }

    const storedMaxInstances = await this.ctx.storage.get<number>('knownMaxInstances');
    if (storedMaxInstances !== undefined) {
      this.knownMaxInstances = storedMaxInstances;
    }

    this.initialized = true;

    await this.scheduleRefresh();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('warmContainers', this.warmContainers);
    await this.ctx.storage.put('assignments', this.assignments);
    if (this.knownMaxInstances !== null) {
      await this.ctx.storage.put('knownMaxInstances', this.knownMaxInstances);
    } else {
      await this.ctx.storage.delete('knownMaxInstances');
    }
  }

  private async scheduleRefresh(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) {
      await this.ctx.storage.setAlarm(Date.now() + this.config.refreshInterval);
    }
  }

  /**
   * Remove a container from pool tracking (warm or assigned)
   * @returns true if the container was found and removed
   */
  private removeContainer(containerUUID: string): boolean {
    let removed = false;

    if (this.warmContainers.delete(containerUUID)) {
      removed = true;
    }

    for (const [userID, uuid] of this.assignments) {
      if (uuid === containerUUID) {
        this.assignments.delete(userID);
        removed = true;
        break;
      }
    }

    return removed;
  }

  private remainingCapacity(): number {
    if (this.knownMaxInstances === null) return Infinity;
    return Math.max(0, this.knownMaxInstances - (this.warmContainers.size + this.assignments.size));
  }

  private isMaxInstancesError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Maximum number of running container instances exceeded');
  }

  private async recordCapacityLimit(): Promise<void> {
    const currentTotal = this.warmContainers.size + this.assignments.size;
    this.knownMaxInstances = currentTotal;
    this.capacityExhausted = true;
    console.warn(
      `Hit max_instances limit. Inferred ceiling: ${currentTotal} ` +
      `(${this.warmContainers.size} warm + ${this.assignments.size} assigned)`
    );
    await this.ctx.storage.put('knownMaxInstances', this.knownMaxInstances);
  }

  /**
   * Start a new container and return its UUID
   */
  private async startContainer(): Promise<string | null> {
    const containerUUID = crypto.randomUUID();

    this.startingContainers.add(containerUUID);

    try {
      const stub = this.getContainerStub(containerUUID);
      const rpc = stub as unknown as ContainerRpc;

      await rpc.startAndWaitForPorts();

      console.log(`Container ${containerUUID} started successfully`);
      return containerUUID;
    } catch (error) {
      if (this.isMaxInstancesError(error)) {
        await this.recordCapacityLimit();
      } else {
        console.error(`Failed to start container ${containerUUID}:`, error);
      }
      return null;
    } finally {
      this.startingContainers.delete(containerUUID);
    }
  }

  /**
   * Check if a container is still running by calling getState() RPC method.
   * A container is considered running only if its status is 'running' or 'healthy'.
   */
  private async isContainerRunning(containerUUID: string): Promise<boolean> {
    // Skip containers that are currently being started
    if (this.startingContainers.has(containerUUID)) {
      return true;
    }

    try {
      const stub = this.getContainerStub(containerUUID);
      const container = stub as unknown as ContainerWithState;
      const state = await container.getState();

      return state.status === 'running' || state.status === 'healthy';
    } catch (error) {
      // If the RPC call fails, assume stopped — better to clean up and reassign
      // than to keep a stale reference
      console.warn(`Failed to check running status for ${containerUUID}, assuming stopped:`, error);
      return false;
    }
  }

  /**
   * Check all tracked containers and remove any that have stopped.
   * Provides resilience if onStop() fails to report.
   */
  private async checkContainerHealth(): Promise<void> {
    const allContainerUUIDs = [
      ...this.warmContainers,
      ...this.assignments.values(),
    ];

    let anyRemoved = false;

    for (const containerUUID of allContainerUUIDs) {
      const running = await this.isContainerRunning(containerUUID);
      if (!running) {
        console.log(`Health check: container ${containerUUID} is not running, removing from pool`);
        if (this.removeContainer(containerUUID)) {
          anyRemoved = true;
        }
      }
    }

    if (anyRemoved) {
      await this.persist();
    }
  }

  /**
   * Scale the warm pool towards warmTarget, respecting the inferred max_instances limit.
   * When at the limit, probes with a single start to detect if max_instances was raised.
   */
  private async adjustPool(): Promise<void> {
    let diff = this.config.warmTarget - this.warmContainers.size;

    if (diff > 0) {
      const capacity = this.remainingCapacity();

      // Probe with one start to detect if max_instances was increased
      if (capacity === 0 && this.knownMaxInstances !== null) {
        console.log(
          `Pool at inferred limit (${this.knownMaxInstances}), probing with 1 container to detect limit changes`
        );
        const probeUUID = await this.startContainer();
        if (probeUUID) {
          console.log('Probe succeeded — max_instances limit appears to have increased, clearing cached limit');
          this.knownMaxInstances = null;
          this.warmContainers.add(probeUUID);
          diff--;
          await this.persist();
        } else {
          await this.persist();
          return;
        }
      }

      const toStart = Math.min(diff, this.remainingCapacity());

      if (toStart <= 0) {
        console.log(
          `Cannot scale up pool: need ${diff} warm containers but only ${this.remainingCapacity()} instance slots available ` +
          `(${this.warmContainers.size} warm + ${this.assignments.size} assigned, limit: ${this.knownMaxInstances ?? 'unknown'})`
        );
        return;
      }

      console.log(`Scaling up pool: starting ${toStart} of ${diff} needed warm containers (capacity: ${this.remainingCapacity()})`);
      for (let i = 0; i < toStart; i++) {
        if (this.capacityExhausted) {
          console.log('Capacity exhausted mid-loop, stopping further starts');
          break;
        }
        const containerUUID = await this.startContainer();
        if (containerUUID) {
          this.warmContainers.add(containerUUID);
        }
      }
      await this.persist();
    } else if (diff < 0) {
      const excess = -diff;
      console.log(`Scaling down pool: stopping ${excess} excess warm containers`);

      const containersToStop = [...this.warmContainers].slice(0, excess);
      const stoppedContainers: string[] = [];

      for (const containerUUID of containersToStop) {
        try {
          const stub = this.getContainerStub(containerUUID);
          await (stub as unknown as ContainerRpc).stop();
          stoppedContainers.push(containerUUID);
        } catch (error) {
          console.error(`Failed to stop container ${containerUUID}:`, error);
        }
      }

      for (const containerUUID of stoppedContainers) {
        this.warmContainers.delete(containerUUID);
      }
      await this.persist();
    }
  }

  private getContainerStub(containerUUID: string): DurableObjectStub {
    const id = this.env.CONTAINER.idFromName(containerUUID);
    return this.env.CONTAINER.get(id);
  }
}
