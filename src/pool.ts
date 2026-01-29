import { DurableObject } from 'cloudflare:workers';
import type {
  PoolConfigInternal,
  PoolStats,
} from './types.js';

const DEFAULT_CONFIG: Required<PoolConfigInternal> = {
  warmTarget: 5,
  refreshInterval: 30 * 1000, // 30 seconds
};

/**
 * Interface for container methods we call via RPC
 */
interface ContainerRpc {
  startAndWaitForPorts(): Promise<void>;
  stop(signal?: string): Promise<void>;
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
  
  /** Container UUIDs currently being started - don't mark these as stopped during health check */
  private startingContainers: Set<string> = new Set();
  
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // ===========================
  // Public RPC Methods
  // ===========================

  /**
   * Get a container UUID for the given user ID
   * - If this ID already has an assigned container, return it
   * - Otherwise assign a warm container (or start a new one)
   */
  async getContainer(userID: string): Promise<string> {
    await this.init();

    // Check if this user ID already has an assigned container
    const existingContainerUUID = this.assignments.get(userID);
    if (existingContainerUUID) {
      return existingContainerUUID;
    }

    // Try to assign a warm container
    if (this.warmContainers.size > 0) {
      const containerUUID = this.warmContainers.values().next().value as string;
      this.warmContainers.delete(containerUUID);
      this.assignments.set(userID, containerUUID);
      await this.persist();
      return containerUUID;
    }

    // No warm containers available - start a new one
    const containerUUID = await this.startContainer();
    if (containerUUID) {
      this.assignments.set(userID, containerUUID);
      await this.persist();
      return containerUUID;
    }

    throw new Error('Failed to start container');
  }

  /**
   * Report that a container has stopped - removes it from tracking
   * Call this from your container's onStop() method
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
   * Shutdown all pre-warmed (unassigned) containers
   * Does not affect containers that are assigned to user IDs
   */
  async shutdownPrewarmed(): Promise<void> {
    await this.init();

    for (const containerUUID of this.warmContainers) {
      try {
        const stub = this.getContainerStub(containerUUID);
        await (stub as unknown as ContainerRpc).stop();
      } catch (error) {
        console.error(`Failed to stop container ${containerUUID}:`, error);
      }
    }
    this.warmContainers.clear();
    await this.persist();
  }

  // ===========================
  // Alarm Handler
  // ===========================

  /**
   * Alarm handler - checks container health and replenishes warm containers
   */
  async alarm(): Promise<void> {
    await this.init();

    try {
      // First, check health of all tracked containers and remove any that stopped
      // This handles cases where onStop() failed to report
      await this.checkContainerHealth();

      // Then adjust pool size to maintain warmTarget
      await this.adjustPool();
    } catch (error) {
      console.error('Alarm handler error:', error);
    }

    // Schedule next alarm
    await this.ctx.storage.setAlarm(Date.now() + this.config.refreshInterval);
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

    this.initialized = true;

    // Schedule refresh alarm
    await this.scheduleRefresh();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('warmContainers', this.warmContainers);
    await this.ctx.storage.put('assignments', this.assignments);
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

    // Remove from warm containers if present
    if (this.warmContainers.delete(containerUUID)) {
      removed = true;
    }

    // Find and remove from assignments if present
    for (const [userID, uuid] of this.assignments) {
      if (uuid === containerUUID) {
        this.assignments.delete(userID);
        removed = true;
        break;
      }
    }

    return removed;
  }

  /**
   * Start a new container and return its UUID
   */
  private async startContainer(): Promise<string | null> {
    const containerUUID = crypto.randomUUID();

    // Track that we're starting this container to avoid false positives in health check
    this.startingContainers.add(containerUUID);

    try {
      const stub = this.getContainerStub(containerUUID);
      const rpc = stub as unknown as ContainerRpc;

      // Start the container and wait for ports (container class handles port config)
      await rpc.startAndWaitForPorts();

      console.log(`Container ${containerUUID} started successfully`);
      return containerUUID;
    } catch (error) {
      console.error(`Failed to start container ${containerUUID}:`, error);
      return null;
    } finally {
      this.startingContainers.delete(containerUUID);
    }
  }

  /**
   * Check if a container is still running by calling getState() RPC method
   * 
   * The Container class from @cloudflare/containers exposes getState() by default.
   * A container is considered stopped if its status is 'stopped' or 'stopped_with_code'.
   */
  private async isContainerRunning(containerUUID: string): Promise<boolean> {
    // Don't check containers that are currently being started
    if (this.startingContainers.has(containerUUID)) {
      return true;
    }

    try {
      const stub = this.getContainerStub(containerUUID);
      const container = stub as unknown as ContainerWithState;
      const state = await container.getState();
      
      // Container is stopped if status is 'stopped' or 'stopped_with_code'
      const isStopped = state.status === 'stopped' || state.status === 'stopped_with_code';
      return !isStopped;
    } catch (error) {
      // If the call fails, assume still running (rely on onStop for cleanup)
      // This could happen if the DO is hibernating or the method throws
      console.warn(`Failed to check running status for ${containerUUID}:`, error);
      return true;
    }
  }

  /**
   * Check all tracked containers and remove any that have stopped
   * This provides resilience if onStop() fails to report
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
   * Adjust the pool to maintain warmTarget containers ready
   * - Starts new containers if below target
   * - Stops excess containers if above target
   */
  private async adjustPool(): Promise<void> {
    const diff = this.config.warmTarget - this.warmContainers.size;

    if (diff > 0) {
      // Need more warm containers - start them
      console.log(`Scaling up pool: need ${diff} more warm containers`);
      for (let i = 0; i < diff; i++) {
        const containerUUID = await this.startContainer();
        if (containerUUID) {
          this.warmContainers.add(containerUUID);
        }
      }
      await this.persist();
    } else if (diff < 0) {
      // Have too many warm containers - stop the excess
      const excess = -diff;
      console.log(`Scaling down pool: stopping ${excess} excess warm containers`);
      
      const containersToStop = [...this.warmContainers].slice(0, excess);
      for (const containerUUID of containersToStop) {
        try {
          const stub = this.getContainerStub(containerUUID);
          await (stub as unknown as ContainerRpc).stop();
        } catch (error) {
          console.error(`Failed to stop container ${containerUUID}:`, error);
        }
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
