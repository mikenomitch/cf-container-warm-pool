/**
 * cf-container-warm-pool
 * 
 * A warm pool manager for Cloudflare Containers and the Sandbox SDK.
 * Pre-warm containers and acquire them on-demand with automatic lifecycle management.
 * 
 * @example
 * ```ts
 * import { createWarmPool, getWarmPool, WarmPool } from 'cf-container-warm-pool';
 * import { Container } from '@cloudflare/containers';
 * 
 * // Define your container with required onStop handler
 * export class MyContainer extends Container<Env> {
 *   defaultPort = 8080;
 * 
 *   async onStop() {
 *     const pool = getWarmPool(this.env.WARM_POOL);
 *     await pool.reportStopped(this.ctx.id.toString());
 *   }
 * }
 * 
 * // Export the WarmPool DO
 * export { WarmPool };
 * 
 * // Use in your Worker
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const pool = createWarmPool(env.WARM_POOL, env.MY_CONTAINER, {
 *       warmTarget: 3,
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
export { createWarmPool, getWarmPool } from './client.js';

// Types
export type {
  WarmPoolClient,
} from './client.js';

export type {
  WarmPoolConfig,
  PoolStats,
} from './types.js';
