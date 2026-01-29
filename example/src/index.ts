// @ts-ignore - @cloudflare/containers has broken type exports, but wrangler handles it correctly
import { Container } from '@cloudflare/containers';
import { createWarmPool, WarmPool } from 'cf-container-warm-pool';

// Environment bindings
export interface Env {
  CONTAINER: DurableObjectNamespace;
  WARM_POOL: DurableObjectNamespace;
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

  // Lifecycle hooks (optional)
  onStart() {
    console.log('Container started');
  }

  onStop({ exitCode }: { exitCode: number }) {
    console.log(`Container stopped with exit code: ${exitCode}`);
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
      // Target number of warm (unacquired) containers to maintain
      warmTarget: 3,
      // Release containers after 5 minutes if not explicitly released
      acquireTimeout: 5 * 60 * 1000,
    });

    // Route: GET /stats - Show pool statistics
    if (url.pathname === '/stats') {
      const stats = await pool.stats();
      return Response.json(stats, {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Route: POST /warmup - Manually trigger warmup
    if (url.pathname === '/warmup' && request.method === 'POST') {
      await pool.warmup();
      return new Response('Warmup initiated', { status: 202 });
    }

    // Route: POST /shutdown - Stop all containers
    if (url.pathname === '/shutdown' && request.method === 'POST') {
      await pool.shutdownAll();
      return new Response('Shutdown complete', { status: 200 });
    }

    // Get a container by session ID
    // Same ID will return the same container (sticky sessions)
    const sessionId = request.headers.get('x-session-id') || 'default';
    const container = await pool.getContainer(sessionId);
    
    // Forward the request to the container
    return container.fetch(request);
  },
};
