import type {
  WarmPoolConfig,
  AcquireOptions,
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
 *   minContainers: 3,
 *   ports: [8080],
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
   * If a warm container is available, it will be assigned to this ID.
   * If this ID already has an assigned container, that container is returned.
   * If no warm containers are available, a new one is started.
   * 
   * @param id - Unique identifier for this container session
   * @returns A container stub ready to use
   */
  getContainer(id: string): Promise<DurableObjectStub>;

  /**
   * Release a container back to the warm pool
   * 
   * Call this when you're done with a container to return it to the pool
   * for reuse by other requests.
   * 
   * @param id - The container ID to release
   */
  releaseContainer(id: string): Promise<void>;

  /**
   * Get current pool statistics
   */
  stats(): Promise<PoolStats>;

  /**
   * Manually trigger warmup of containers
   * 
   * @param count - Number of containers to warm (defaults to minContainers)
   */
  warmup(count?: number): Promise<void>;

  /**
   * Shutdown all containers in the pool
   */
  shutdown(): Promise<void>;
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
 *       minContainers: 3,
 *       maxContainers: 10,
 *       ports: [8080],
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
  // Use a singleton pool instance per namespace
  const poolId = poolNamespace.idFromName('global-pool');
  const poolStub = poolNamespace.get(poolId);

  // Configure the pool on first use
  let configured = false;
  const ensureConfigured = async () => {
    if (!configured && config) {
      await sendMessage(poolStub, { type: 'warmup', count: config.minContainers });
      configured = true;
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
      await ensureConfigured();

      const response = await sendMessage(poolStub, { type: 'get', id });

      if (response.type === 'error') {
        throw new Error(response.message);
      }

      if (response.type !== 'container') {
        throw new Error(`Unexpected response type: ${response.type}`);
      }

      const containerId = response.containerId;
      const doId = containerNamespace.idFromName(containerId);
      return containerNamespace.get(doId);
    },

    async releaseContainer(id: string): Promise<void> {
      const response = await sendMessage(poolStub, { type: 'release', id });

      if (response.type === 'error') {
        throw new Error(response.message);
      }
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

    async warmup(count?: number): Promise<void> {
      const response = await sendMessage(poolStub, { type: 'warmup', count });

      if (response.type === 'error') {
        throw new Error(response.message);
      }
    },

    async shutdown(): Promise<void> {
      const response = await sendMessage(poolStub, { type: 'shutdown' });

      if (response.type === 'error') {
        throw new Error(response.message);
      }
    },
  };
}
