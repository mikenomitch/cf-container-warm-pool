import type {
  WarmPoolConfig,
  PoolStats,
  PoolMessage,
  PoolResponse,
} from './types.js';

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
  poolNamespace: DurableObjectNamespace,
  containerNamespace: DurableObjectNamespace,
  config?: WarmPoolConfig
): WarmPoolClient {
  const poolName = config?.poolName ?? 'global-pool';
  const poolStub = getWarmPool(poolNamespace, poolName);

  // Trigger initial warmup on first use
  let initialized = false;
  const ensureInitialized = async () => {
    if (!initialized && config?.warmTarget) {
      // Just getting stats will trigger the alarm which handles warmup
      await sendMessage(poolStub, { type: 'stats' });
      initialized = true;
    }
  };

  const sendMessage = async (stub: DurableObjectStub, message: PoolMessage): Promise<PoolResponse> => {
    const response = await stub.fetch('http://pool/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Pool error: ${error}`);
    }

    return response.json();
  };

  return {
    async getContainer(id: string): Promise<DurableObjectStub> {
      await ensureInitialized();

      const response = await sendMessage(poolStub, { type: 'get', id });

      if (response.type === 'error') {
        throw new Error(response.message);
      }

      if (response.type !== 'container') {
        throw new Error(`Unexpected response type: ${response.type}`);
      }

      const containerUUID = response.containerId;
      const doId = containerNamespace.idFromName(containerUUID);
      return containerNamespace.get(doId);
    },

    async stats(): Promise<PoolStats> {
      const response = await sendMessage(poolStub, { type: 'stats' });

      if (response.type === 'error') {
        throw new Error(response.message);
      }

      if (response.type !== 'stats') {
        throw new Error(`Unexpected response type: ${response.type}`);
      }

      return response.stats;
    },

    async shutdownPrewarmed(): Promise<void> {
      const response = await sendMessage(poolStub, { type: 'shutdownPrewarmed' });

      if (response.type === 'error') {
        throw new Error(response.message);
      }
    },
  };
}

/**
 * Get the WarmPool Durable Object stub
 * 
 * Use this to call reportStopped() from your container's onStop() method.
 * 
 * @param poolNamespace - The WarmPool Durable Object namespace binding
 * @param poolName - Name of the pool instance (default: 'global-pool'). Use this if you have multiple container types.
 * @returns The WarmPool Durable Object stub
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
export function getWarmPool(poolNamespace: DurableObjectNamespace, poolName: string = 'global-pool'): DurableObjectStub {
  const poolId = poolNamespace.idFromName(poolName);
  return poolNamespace.get(poolId);
}
