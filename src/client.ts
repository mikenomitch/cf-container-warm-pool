import type {
  WarmPoolConfig,
  PoolStats,
  PoolConfigInternal,
} from './types.js';
import type { WarmPool } from './pool.js';

/**
 * Client for interacting with a WarmPool Durable Object
 * 
 * Use this in your Worker to get containers from the pool.
 * 
 * @example
 * ```ts
 * const pool = createWarmPool(env.WARM_POOL, env.CONTAINER, {
 *   warmTarget: 3,
 * });
 * 
 * // Get a container by ID (will use warm container or start new one)
 * const container = await pool.getContainer('session-123');
 * return container.fetch(request);
 * ```
 */
export interface WarmPoolClient {
  /**
   * Get a container by ID from the warm pool
   * 
   * If this ID already has an assigned container, returns the same container.
   * If not, assigns a warm container from the pool.
   * If no warm containers available, starts a new one.
   * 
   * @param id - Unique identifier for this container session
   * @returns A container stub ready to use
   */
  getContainer(id: string): Promise<DurableObjectStub>;

  /**
   * Get current pool statistics
   */
  stats(): Promise<PoolStats>;

  /**
   * Shutdown all pre-warmed (unassigned) containers
   */
  shutdownPrewarmed(): Promise<void>;
}

/**
 * Create a WarmPool client for managing pre-warmed containers
 * 
 * @param poolNamespace - The WarmPool Durable Object namespace binding
 * @param containerNamespace - The Container Durable Object namespace binding
 * @param config - Pool configuration options
 * @returns A WarmPoolClient for acquiring and managing containers
 * 
 * @example
 * ```ts
 * // In your Worker
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const pool = createWarmPool(env.WARM_POOL, env.CONTAINER, {
 *       warmTarget: 3,
 *     });
 * 
 *     // Get container by session ID
 *     const sessionId = request.headers.get('x-session-id') || 'default';
 *     const container = await pool.getContainer(sessionId);
 *     return container.fetch(request);
 *   }
 * };
 * ```
 */
export function createWarmPool(
  poolNamespace: DurableObjectNamespace<WarmPool>,
  containerNamespace: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): DurableObjectStub },
  config?: WarmPoolConfig
): WarmPoolClient {
  const poolName = config?.poolName ?? 'global-pool';
  const poolId = poolNamespace.idFromName(poolName);
  const poolStub = poolNamespace.get(poolId);

  // Extract pool config (excluding poolName which is client-side only)
  const { poolName: _, ...poolConfig } = config ?? {};

  return {
    async getContainer(id: string): Promise<DurableObjectStub> {
      // Send config first to ensure it's always up-to-date (handles redeployments)
      await poolStub.configure(poolConfig);
      
      const containerUUID = await poolStub.getContainer(id);
      const doId = containerNamespace.idFromName(containerUUID);
      return containerNamespace.get(doId);
    },

    async stats(): Promise<PoolStats> {
      // Send config first to ensure it's always up-to-date (handles redeployments)
      await poolStub.configure(poolConfig);
      
      return poolStub.getStats();
    },

    async shutdownPrewarmed(): Promise<void> {
      // Send config first to ensure it's always up-to-date (handles redeployments)
      await poolStub.configure(poolConfig);
      
      await poolStub.shutdownPrewarmed();
    },
  };
}

/**
 * Get the WarmPool Durable Object stub for RPC calls
 * 
 * Use this to call reportStopped() from your container's onStop() method.
 * 
 * @param poolNamespace - The WarmPool Durable Object namespace binding
 * @param poolName - Name of the pool instance (default: 'global-pool'). Use this if you have multiple container types.
 * @returns The WarmPool Durable Object stub with RPC methods
 * 
 * @example
 * ```ts
 * import { getWarmPool } from 'cf-container-warm-pool';
 * 
 * export class MyContainer extends Container<Env> {
 *   async onStop() {
 *     const pool = getWarmPool(this.env.WARM_POOL);
 *     await pool.reportStopped(this.ctx.id.toString());
 *   }
 * }
 * ```
 */
export function getWarmPool(
  poolNamespace: DurableObjectNamespace<WarmPool>,
  poolName: string = 'global-pool'
): DurableObjectStub<WarmPool> {
  const poolId = poolNamespace.idFromName(poolName);
  return poolNamespace.get(poolId);
}
