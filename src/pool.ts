import { DurableObject } from 'cloudflare:workers';
import type {
  PoolConfigInternal,
  PoolStats,
  PoolMessage,
  PoolResponse,
  WarmPoolConfig,
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
 * WarmPool Durable Object - manages a pool of pre-warmed containers
 * 
 * Maintains warm containers ready for immediate use. When a user requests a container
 * by ID, they get a 1:1 mapping that persists. No sharing between user IDs.
 */
export class WarmPool<Env extends { CONTAINER: DurableObjectNamespace } = { CONTAINER: DurableObjectNamespace }> extends DurableObject<Env> {
  private config: Required<PoolConfigInternal> = DEFAULT_CONFIG;
  
  /** Container UUIDs that are warm and available for assignment */
  private warmContainers: Set<string> = new Set();
  
  /** Maps user-provided IDs to container UUIDs (1:1, no sharing) */
  private assignments: Map<string, string> = new Map();
  
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

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
   * Alarm handler - replenishes warm containers to reach warmTarget
   */
  async alarm(): Promise<void> {
    await this.init();

    try {
      await this.replenishPool();
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
      case 'reportStopped':
        return this.handleReportStopped(message.containerUUID);
      case 'stats':
        return this.handleStats();
      case 'shutdownPrewarmed':
        return this.handleShutdownPrewarmed();
      default:
        throw new Error(`Unknown message type: ${(message as PoolMessage).type}`);
    }
  }

  /**
   * Get a container for the given user ID
   * - If this ID already has an assigned container, return it
   * - Otherwise assign a warm container (or start a new one)
   */
  private async handleGet(userID: string): Promise<PoolResponse> {
    // Check if this user ID already has an assigned container
    const existingContainerUUID = this.assignments.get(userID);
    if (existingContainerUUID) {
      return { type: 'container', containerId: existingContainerUUID };
    }

    // Try to assign a warm container
    if (this.warmContainers.size > 0) {
      const containerUUID = this.warmContainers.values().next().value as string;
      this.warmContainers.delete(containerUUID);
      this.assignments.set(userID, containerUUID);
      await this.persist();
      return { type: 'container', containerId: containerUUID };
    }

    // No warm containers available - start a new one
    const containerUUID = await this.startContainer();
    if (containerUUID) {
      this.assignments.set(userID, containerUUID);
      await this.persist();
      return { type: 'container', containerId: containerUUID };
    }

    throw new Error('Failed to start container');
  }

  /**
   * Called when a container stops - removes it from tracking
   * This should be called from the container's onStop() method
   */
  private async handleReportStopped(containerUUID: string): Promise<PoolResponse> {
    // Remove from warm containers if present
    this.warmContainers.delete(containerUUID);

    // Find and remove from assignments if present
    for (const [userID, uuid] of this.assignments) {
      if (uuid === containerUUID) {
        this.assignments.delete(userID);
        break;
      }
    }

    await this.persist();
    return { type: 'stopped' };
  }

  /**
   * Called via RPC from container's onStop() method
   */
  async reportStopped(containerUUID: string): Promise<void> {
    await this.init();
    await this.handleReportStopped(containerUUID);
  }

  private handleStats(): PoolResponse {
    const stats: PoolStats = {
      warm: this.warmContainers.size,
      assigned: this.assignments.size,
      total: this.warmContainers.size + this.assignments.size,
      config: this.config,
    };

    return { type: 'stats', stats };
  }

  /**
   * Shutdown only the pre-warmed (unassigned) containers
   */
  private async handleShutdownPrewarmed(): Promise<PoolResponse> {
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
    return { type: 'shutdown' };
  }

  /**
   * Start a new container and return its UUID
   */
  private async startContainer(): Promise<string | null> {
    const containerUUID = crypto.randomUUID();

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
    }
  }

  /**
   * Replenish the pool to maintain warmTarget containers ready
   */
  private async replenishPool(): Promise<void> {
    const needed = this.config.warmTarget - this.warmContainers.size;

    if (needed > 0) {
      console.log(`Replenishing pool: need ${needed} more warm containers`);
      for (let i = 0; i < needed; i++) {
        const containerUUID = await this.startContainer();
        if (containerUUID) {
          this.warmContainers.add(containerUUID);
        }
      }
      await this.persist();
    }
  }

  private getContainerStub(containerUUID: string): DurableObjectStub {
    const id = this.env.CONTAINER.idFromName(containerUUID);
    return this.env.CONTAINER.get(id);
  }
}
