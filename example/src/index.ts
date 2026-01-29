// @ts-ignore - @cloudflare/containers has broken type exports, but wrangler handles it correctly
import { Container } from '@cloudflare/containers';
import { createWarmPool, getWarmPool, WarmPool } from 'cf-container-warm-pool';

// Environment bindings
export interface Env {
  CONTAINER: DurableObjectNamespace;
  WARM_POOL: DurableObjectNamespace<WarmPool>;
}

/**
 * Your container class - extends the base Container from @cloudflare/containers
 * Configure any container-specific settings here.
 */
export class MyContainer extends Container<Env> {
  // The default port your container listens on
  defaultPort = 8080;

  // How long before an idle container is stopped
  sleepAfter = '10m';

  onStart() {
    console.log('Container started');
  }

  /**
   * RECOMMENDED: Notify the warm pool immediately when this container stops.
   * This allows the pool to remove stopped containers and replenish warm ones
   * without waiting for the next health check interval.
   */
  async onStop() {
    // @ts-ignore - env and ctx exist on Container, types are broken in @cloudflare/containers
    const pool = getWarmPool(this.env.WARM_POOL);
    // @ts-ignore
    await pool.reportStopped(this.ctx.id.toString());
  }
}

// Export the WarmPool Durable Object for wrangler to use
export { WarmPool };

/**
 * Main Worker entry point
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Create the warm pool client with configuration
    const pool = createWarmPool(env.WARM_POOL, env.CONTAINER, {
      // Target number of warm (unassigned) containers to maintain
      warmTarget: 3,
    });

    // Route: GET /stats - Show pool statistics
    if (url.pathname === '/stats') {
      const stats = await pool.stats();
      return Response.json(stats, {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Route: POST /shutdown-prewarmed - Stop all pre-warmed containers
    if (url.pathname === '/shutdown-prewarmed' && request.method === 'POST') {
      await pool.shutdownPrewarmed();
      return new Response('Pre-warmed containers shutdown complete', { status: 200 });
    }

    // Get a container by session ID
    // Same ID will always return the same container (1:1 mapping)
    const sessionId = request.headers.get('x-session-id') || 'default';
    const container = await pool.getContainer(sessionId);
    
    // Forward the request to the container
    return container.fetch(request);
  },
};
