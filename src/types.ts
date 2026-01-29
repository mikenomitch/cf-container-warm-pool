/**
 * Status of a container in the warm pool
 */
export type ContainerStatus = 
  | 'warming'    // Container is starting up
  | 'warm'       // Container is ready and available
  | 'acquired'   // Container is in use
  | 'stopped';   // Container has stopped

/**
 * Internal record for tracking a container in the pool
 */
export interface PooledContainer {
  id: string;
  status: ContainerStatus;
  assignedTo?: string;  // The user-provided ID this container is assigned to
  acquiredAt?: number;
  warmedAt?: number;
  lastHealthCheck?: number;
}

/**
 * Configuration for the warm pool
 */
export interface WarmPoolConfig {
  /**
   * Number of containers to keep warm
   * @default 1
   */
  minContainers?: number;

  /**
   * Maximum number of containers (including acquired)
   * @default 10
   */
  maxContainers?: number;

  /**
   * How long a container can be acquired before auto-release (ms)
   * @default 300000 (5 minutes)
   */
  acquireTimeout?: number;

  /**
   * How often to check pool health and replenish (ms)
   * @default 30000 (30 seconds)
   */
  healthCheckInterval?: number;

  /**
   * Ports to wait for during container warmup
   */
  ports?: number[];

  /**
   * Timeout for container startup (ms)
   * @default 30000 (30 seconds)
   */
  startupTimeout?: number;
}

/**
 * Stats about the warm pool
 */
export interface PoolStats {
  warm: number;
  acquired: number;
  warming: number;
  total: number;
  config: Required<WarmPoolConfig>;
}

/**
 * Options when acquiring a container
 */
export interface AcquireOptions {
  /**
   * AbortSignal to cancel the acquire operation
   */
  signal?: AbortSignal;

  /**
   * Maximum time to wait for a container (ms)
   * @default 30000 (30 seconds)
   */
  timeout?: number;
}

/**
 * Message types for internal RPC between Worker and WarmPool DO
 */
export type PoolMessage =
  | { type: 'get'; id: string }
  | { type: 'release'; id: string }
  | { type: 'stats' }
  | { type: 'warmup'; count?: number }
  | { type: 'shutdown' };

export type PoolResponse =
  | { type: 'container'; containerId: string }
  | { type: 'released' }
  | { type: 'stats'; stats: PoolStats }
  | { type: 'warming' }
  | { type: 'shutdown' }
  | { type: 'error'; message: string };
