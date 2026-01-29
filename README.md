# cf-container-warm-pool

A warm pool manager for Cloudflare Containers. Pre-warm containers and acquire them on-demand with automatic lifecycle management.

## Installation

```bash
npm install cf-container-warm-pool @cloudflare/containers
```

## Quick Start

```ts
import { Container } from '@cloudflare/containers';
import { createWarmPool, WarmPool } from 'cf-container-warm-pool';

// Define your container
export class MyContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';
}

// Export the WarmPool DO
export { WarmPool };

// Use in your Worker
export default {
  async fetch(request: Request, env: Env) {
    const pool = createWarmPool(env.WARM_POOL, env.CONTAINER, {
      minContainers: 3,
      maxContainers: 10,
      ports: [8080],
    });

    // Get a container by ID (sticky sessions)
    const sessionId = request.headers.get('x-session-id') || 'default';
    const container = await pool.getContainer(sessionId);
    return container.fetch(request);
  }
};
```

## Configuration

Configure your `wrangler.jsonc`:

```jsonc
{
  "name": "my-app",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-13",

  "containers": [
    {
      "class_name": "MyContainer",
      "image": "./Dockerfile",
      "max_instances": 10,
      "name": "my-container"
    }
  ],

  "durable_objects": {
    "bindings": [
      { "class_name": "MyContainer", "name": "CONTAINER" },
      { "class_name": "WarmPool", "name": "WARM_POOL" }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyContainer", "WarmPool"]
    }
  ]
}
```

## API

### `createWarmPool(poolNamespace, containerNamespace, config?)`

Creates a warm pool client.

**Config options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `minContainers` | number | 1 | Number of containers to keep warm |
| `maxContainers` | number | 10 | Maximum containers including acquired |
| `acquireTimeout` | number | 300000 | Auto-release after this many ms |
| `healthCheckInterval` | number | 30000 | Pool health check interval (ms) |
| `ports` | number[] | [] | Ports to wait for during warmup |
| `startupTimeout` | number | 30000 | Container startup timeout (ms) |

### `pool.getContainer(id)`

Get a container by ID. This mirrors the `getContainer` interface from `@cloudflare/containers`.

- If this ID already has an assigned container, returns the same container (sticky sessions)
- If not, assigns a warm container from the pool
- If no warm containers available, starts a new one (up to `maxContainers`)

```ts
const container = await pool.getContainer('user-session-123');
const response = await container.fetch(request);
```

### `pool.releaseContainer(id)`

Release a container back to the warm pool for reuse.

```ts
await pool.releaseContainer('user-session-123');
```

### `pool.stats()`

Get current pool statistics.

```ts
const stats = await pool.stats();
// { warm: 3, acquired: 1, warming: 0, total: 4, config: {...} }
```

### `pool.warmup(count?)`

Manually trigger container warmup.

```ts
await pool.warmup(5); // Warm up 5 containers
```

### `pool.shutdown()`

Stop all containers in the pool.

```ts
await pool.shutdown();
```

## How It Works

1. **Pre-warming**: On first request, the pool warms up `minContainers` containers

2. **Sticky sessions**: `getContainer(id)` returns the same container for the same ID, enabling session affinity

3. **Automatic assignment**: If no container is assigned to an ID, a warm one is assigned from the pool

4. **Auto-release**: Containers are automatically released after `acquireTimeout` to prevent leaks

5. **Health checks**: A background alarm monitors pool health and replenishes warm containers

## Example

See the `/example` directory for a complete working example including:
- Container Dockerfile
- Worker code with routing
- wrangler.jsonc configuration

```bash
cd example
npm install
npm run dev
```

## License

MIT
