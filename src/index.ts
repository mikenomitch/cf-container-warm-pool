/**
 * cf-container-warm-pool
 * 
 * A warm pool manager for Cloudflare Containers. Pre-warm containers 
 * and acquire them on-demand with automatic lifecycle management.
 * 
 * @example
 * ```ts
 * import { createWarmPool, WarmPool } from 'cf-container-warm-pool';
 * import { Container } from '@cloudflare/containers';
 * 
 * // Define your container
 * export class MyContainer extends Container {
 *   defaultPort = 8080;
 * }
 * 
 * // Export the WarmPool DO
 * export { WarmPool };
 * 
 * // Use in your Worker
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const pool = createWarmPool(env.WARM_POOL, env.MY_CONTAINER, {
 *       minContainers: 3,
 *       ports: [8080],
 *     });
 * 
 *     const container = await pool.getContainer('session-123');
 *     return container.fetch(request);
 *   }
 * };
 * ```
 */

// Core pool management
export { WarmPool } from './pool.js';
export { createWarmPool } from './client.js';

// Types
export type {
  WarmPoolClient,
} from './client.js';

export type {
  WarmPoolConfig,
  AcquireOptions,
  PoolStats,
  ContainerStatus,
  PooledContainer,
} from './types.js';
