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
   * Target number of warm (unacquired) containers to maintain.
   * The pool will start new containers to maintain this many ready for immediate use.
   * @default 1
   */
  warmTarget?: number;

  /**
   * How long a container can be acquired before auto-release (ms)
   * @default 300000 (5 minutes)
   */
  acquireTimeout?: number;

  /**
   * How often to refresh the pool - checks for expired acquisitions and replenishes warm containers (ms)
   * @default 30000 (30 seconds)
   */
  refreshInterval?: number;
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
