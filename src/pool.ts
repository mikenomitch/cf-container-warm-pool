import { DurableObject } from 'cloudflare:workers';
import type {
  WarmPoolConfig,
  PooledContainer,
  ContainerStatus,
  PoolStats,
  PoolMessage,
  PoolResponse,
} from './types.js';

const DEFAULT_CONFIG: Required<WarmPoolConfig> = {
  warmTarget: 1,
  acquireTimeout: 5 * 60 * 1000, // 5 minutes
  refreshInterval: 30 * 1000, // 30 seconds
};

/**
 * Interface for container methods we call via RPC
 */
interface ContainerRpc {
  startAndWaitForPorts(): Promise<void>;
  stop(signal?: string): Promise<void>;
  getStatus(): Promise<string>;
}

/**
 * WarmPool Durable Object - manages a pool of pre-warmed containers
 * 
 * This DO maintains state about which containers are warm, acquired, or warming.
 * It handles the lifecycle of keeping containers warm and ready for use.
 */
export class WarmPool<Env extends { CONTAINER: DurableObjectNamespace } = { CONTAINER: DurableObjectNamespace }> extends DurableObject<Env> {
  private config: Required<WarmPoolConfig> = DEFAULT_CONFIG;
  private containers: Map<string, PooledContainer> = new Map();
  // Maps user-provided IDs to container IDs
  private assignments: Map<string, string> = new Map();
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * Configure the warm pool settings
   */
  configure(config: WarmPoolConfig): void {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the pool - loads state and starts warmup
   */
  private async init(): Promise<void> {
    if (this.initialized) return;

    // Load persisted state
    const stored = await this.ctx.storage.get<Map<string, PooledContainer>>('containers');
    if (stored) {
      this.containers = new Map(stored);
      // Reset any containers that were in transient states
      for (const [id, container] of this.containers) {
        if (container.status === 'warming') {
          container.status = 'stopped';
        }
      }
    }

    const storedAssignments = await this.ctx.storage.get<Map<string, string>>('assignments');
    if (storedAssignments) {
      this.assignments = new Map(storedAssignments);
    }

    const storedConfig = await this.ctx.storage.get<WarmPoolConfig>('config');
    if (storedConfig) {
      this.config = { ...DEFAULT_CONFIG, ...storedConfig };
    }

    this.initialized = true;

    // Schedule health check alarm
    await this.scheduleHealthCheck();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('containers', this.containers);
    await this.ctx.storage.put('assignments', this.assignments);
  }

  private async persistConfig(): Promise<void> {
    await this.ctx.storage.put('config', this.config);
  }

  private async scheduleHealthCheck(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) {
      await this.ctx.storage.setAlarm(Date.now() + this.config.refreshInterval);
    }
  }

  /**
   * Alarm handler - performs health checks and replenishes pool
   */
  async alarm(): Promise<void> {
    await this.init();

    try {
      // Check for expired acquisitions
      const now = Date.now();
      for (const [containerId, container] of this.containers) {
        if (
          container.status === 'acquired' &&
          container.acquiredAt &&
          now - container.acquiredAt > this.config.acquireTimeout
        ) {
          console.log(`Container ${containerId} acquisition expired, releasing`);
          this.releaseContainerById(containerId);
        }
      }

      // Replenish warm containers
      await this.replenishPool();

      // Health check warm containers
      await this.healthCheckWarmContainers();

      await this.persist();
    } catch (error) {
      console.error('Alarm handler error:', error);
    }

    // Schedule next alarm
    await this.ctx.storage.setAlarm(Date.now() + this.config.refreshInterval);
  }

  /**
   * Main fetch handler - processes pool messages
   */
  async fetch(request: Request): Promise<Response> {
    await this.init();

    try {
      const message = await request.json() as PoolMessage;
      const response = await this.handleMessage(message);
      return Response.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return Response.json({ type: 'error', message } as PoolResponse, { status: 500 });
    }
  }

  private async handleMessage(message: PoolMessage): Promise<PoolResponse> {
    switch (message.type) {
      case 'get':
        return this.handleGet(message.id);
      case 'release':
        return this.handleRelease(message.id);
      case 'stats':
        return this.handleStats();
      case 'warmup':
        return this.handleWarmup(message.count);
      case 'shutdown':
        return this.handleShutdown();
      default:
        throw new Error(`Unknown message type: ${(message as PoolMessage).type}`);
    }
  }

  /**
   * Get a container for the given user ID
   * - If this ID already has an assigned container, return it
   * - Otherwise assign a warm container (or start a new one)
   */
  private async handleGet(id: string): Promise<PoolResponse> {
    // Check if this ID already has an assigned container
    const existingContainerId = this.assignments.get(id);
    if (existingContainerId) {
      const container = this.containers.get(existingContainerId);
      if (container && (container.status === 'acquired' || container.status === 'warm')) {
        // Refresh the acquisition time
        container.acquiredAt = Date.now();
        container.status = 'acquired';
        await this.persist();
        return { type: 'container', containerId: existingContainerId };
      }
      // Container no longer valid, remove assignment
      this.assignments.delete(id);
    }

    // Try to find a warm container
    for (const [containerId, container] of this.containers) {
      if (container.status === 'warm') {
        container.status = 'acquired';
        container.acquiredAt = Date.now();
        container.assignedTo = id;
        this.assignments.set(id, containerId);
        await this.persist();
        return { type: 'container', containerId };
      }
    }

    // No warm container available, start a new one
    const containerId = await this.warmupContainer();
    if (containerId) {
      const container = this.containers.get(containerId);
      if (container) {
        container.status = 'acquired';
        container.acquiredAt = Date.now();
        container.assignedTo = id;
        this.assignments.set(id, containerId);
        await this.persist();
        return { type: 'container', containerId };
      }
    }

    // Failed to start a container (system will error if over max_instances)
    throw new Error('Failed to start container');
  }

  /**
   * Release a container by user-provided ID
   */
  private async handleRelease(id: string): Promise<PoolResponse> {
    const containerId = this.assignments.get(id);
    if (containerId) {
      this.releaseContainerById(containerId);
      this.assignments.delete(id);
      await this.persist();
    }
    return { type: 'released' };
  }

  /**
   * Release a container by its internal container ID
   */
  private releaseContainerById(containerId: string): void {
    const container = this.containers.get(containerId);
    if (!container) {
      return;
    }

    container.status = 'warm';
    container.acquiredAt = undefined;
    container.assignedTo = undefined;

    // Also clean up any assignments pointing to this container
    for (const [id, cid] of this.assignments) {
      if (cid === containerId) {
        this.assignments.delete(id);
      }
    }
  }

  private handleStats(): PoolResponse {
    const stats: PoolStats = {
      warm: 0,
      acquired: 0,
      warming: 0,
      total: this.containers.size,
      config: this.config,
    };

    for (const container of this.containers.values()) {
      switch (container.status) {
        case 'warm':
          stats.warm++;
          break;
        case 'acquired':
          stats.acquired++;
          break;
        case 'warming':
          stats.warming++;
          break;
      }
    }

    return { type: 'stats', stats };
  }

  private async handleWarmup(count?: number): Promise<PoolResponse> {
    const target = count ?? this.config.warmTarget;
    const currentWarm = this.countByStatus('warm');
    const warmingCount = this.countByStatus('warming');
    const needed = target - currentWarm - warmingCount;

    for (let i = 0; i < needed; i++) {
      await this.warmupContainer();
    }

    return { type: 'warming' };
  }

  private async handleShutdown(): Promise<PoolResponse> {
    // Stop all containers
    for (const [id, container] of this.containers) {
      if (container.status !== 'stopped') {
        try {
          const stub = this.getContainerStub(id);
          await (stub as unknown as ContainerRpc).stop();
        } catch (error) {
          console.error(`Failed to stop container ${id}:`, error);
        }
        container.status = 'stopped';
      }
    }
    this.assignments.clear();
    await this.persist();
    return { type: 'shutdown' };
  }

  private countByStatus(status: ContainerStatus): number {
    let count = 0;
    for (const container of this.containers.values()) {
      if (container.status === status) count++;
    }
    return count;
  }

  /**
   * Warm up a new container and add it to the pool
   */
  private async warmupContainer(): Promise<string | null> {
    const containerId = crypto.randomUUID();

    const pooledContainer: PooledContainer = {
      id: containerId,
      status: 'warming',
    };
    this.containers.set(containerId, pooledContainer);
    await this.persist();

    try {
      const stub = this.getContainerStub(containerId);
      const rpc = stub as unknown as ContainerRpc;

      // Start the container and wait for ports (container class handles port config)
      await rpc.startAndWaitForPorts();

      pooledContainer.status = 'warm';
      pooledContainer.warmedAt = Date.now();
      await this.persist();

      console.log(`Container ${containerId} warmed up successfully`);
      return containerId;
    } catch (error) {
      console.error(`Failed to warm up container ${containerId}:`, error);
      this.containers.delete(containerId);
      await this.persist();
      return null;
    }
  }

  /**
   * Replenish the pool to maintain warmTarget containers ready
   */
  private async replenishPool(): Promise<void> {
    const warmCount = this.countByStatus('warm');
    const warmingCount = this.countByStatus('warming');
    const needed = this.config.warmTarget - warmCount - warmingCount;

    if (needed > 0) {
      console.log(`Replenishing pool: need ${needed} more warm containers`);
      for (let i = 0; i < needed; i++) {
        await this.warmupContainer();
      }
    }
  }

  /**
   * Health check warm containers
   */
  private async healthCheckWarmContainers(): Promise<void> {
    for (const [id, container] of this.containers) {
      if (container.status === 'warm') {
        try {
          const stub = this.getContainerStub(id);
          const rpc = stub as unknown as ContainerRpc;
          const status = await rpc.getStatus();

          if (status !== 'running' && status !== 'healthy') {
            console.log(`Container ${id} is no longer healthy (${status}), removing from pool`);
            this.containers.delete(id);
          } else {
            container.lastHealthCheck = Date.now();
          }
        } catch (error) {
          console.error(`Health check failed for container ${id}:`, error);
          this.containers.delete(id);
        }
      }
    }
  }

  private getContainerStub(containerId: string): DurableObjectStub {
    const id = this.env.CONTAINER.idFromName(containerId);
    return this.env.CONTAINER.get(id);
  }
}
