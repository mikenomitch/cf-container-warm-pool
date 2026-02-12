/**
 * Configuration for the warm pool
 */
export interface WarmPoolConfig {
  /**
   * Target number of warm (unassigned) containers to maintain.
   * The pool will start new containers to keep this many ready for immediate use.
   * @default 5
   */
  warmTarget?: number;

  /**
   * How often to check and replenish warm containers (ms)
   * @default 10000 (10 seconds)
   */
  refreshInterval?: number;

  /**
   * Name of the pool instance. Use this if you have multiple container types
   * and need separate warm pools for each.
   * @default 'global-pool'
   */
  poolName?: string;

  /**
   * Optional KV namespace used to cache `userId -> containerId` lookups.
   * When present, `getContainer()` will read from KV first and only fall back to the
   * warm pool Durable Object on a miss.
   */
  kvNamespace?: KVNamespace;
}

/**
 * Internal pool config (excludes poolName which is only used client-side)
 */
export type PoolConfigInternal = Omit<WarmPoolConfig, 'poolName' | 'kvNamespace'>;

/**
 * Stats about the warm pool
 */
export interface PoolStats {
  /** Number of warm (unassigned) containers ready for use */
  warm: number;
  /** Number of containers assigned to user IDs */
  assigned: number;
  /** Total containers tracked by the pool */
  total: number;
  /** Current pool configuration */
  config: Required<PoolConfigInternal>;
}

