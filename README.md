# cf-container-warm-pool

A warm pool manager for [Cloudflare Containers](https://developers.cloudflare.com/containers/) and the [Sandboxs](https://github.com/cloudflare/sandbox-sdk). Pre-warm containers and acquire them on-demand with automatic lifecycle management. Cloudflare will already pre-warm container instances behind the scenes so startup times can often be a little over a second without this library. This provides an additional layer for extra speed and buffer.

> **This is a temporary solution.** Cloudflare plans to make this unnecessary with faster default start times using disk and memory snapshots. Use this library now, then remove it once that functionality ships.
>
> **Cost consideration:** Pre-warmed containers are billed while sitting in the pool. This is the main tradeoff of using this library.

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
  
  onStart() {
    // anything to do when the container is initially started/warmed
  }
}

// Register the WarmPool Storage
export { WarmPool };

// Use in your Worker
export default {
  async fetch(request: Request, env: Env) {
    const pool = createWarmPool(env.WARM_POOL, env.CONTAINER, {
      warmTarget: 3, // how many additional containers to keep ready
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
  "compatibility_date": "2026-01-28",

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
      { "class_name": "MyContainer", "name": "CONTAINER" }, // your original container binding
      { "class_name": "WarmPool", "name": "WARM_POOL" } // additional binding for the pool
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyContainer"] // your original migration
    },
    {
      "tag": "v2",
      "new_sqlite_classes": ["WarmPool"] // additional migration for the warm pool
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
| `warmTarget` | number | 1 | Target number of warm (unacquired) containers to maintain ready for immediate use |
| `acquireTimeout` | number | 300000 | Auto-release after this many ms |
| `refreshInterval` | number | 30000 | How often to check for expired acquisitions and replenish pool (ms) |

### `pool.getContainer(id)`

Get a container by ID. This mirrors the `getContainer` interface from `@cloudflare/containers`.

- If this ID already has an assigned container, returns the same container (sticky sessions)
- If not, assigns a warm container from the pool
- If no warm containers available, starts a new one

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

### `pool.shutdownAll()`

Stop all containers in the pool.

```ts
await pool.shutdownAll();
```

## How It Works

1. **Pre-warming**: On first request, the pool starts warming containers to reach `warmTarget`

2. **Sticky sessions**: `getContainer(id)` returns the same container for the same ID, enabling session affinity

3. **Automatic assignment**: If no container is assigned to an ID, a warm one is assigned from the pool

4. **Auto-release**: Containers are automatically released after `acquireTimeout` to prevent leaks

5. **Pool refresh**: A background alarm checks for expired acquisitions and replenishes warm containers to maintain `warmTarget`

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

## Sandbox SDK Example

This library also works with the [Sandbox SDK](https://github.com/cloudflare/sandbox-sdk) (`@cloudflare/sandbox`). The Sandbox SDK extends the Container class with additional methods for code execution, file operations, and more.

```ts
import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import { createWarmPool, WarmPool } from 'cf-container-warm-pool';

export { Sandbox, WarmPool };

export interface Env {
  SANDBOX: DurableObjectNamespace;
  WARM_POOL: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env) {
    const pool = createWarmPool(env.WARM_POOL, env.SANDBOX, {
      warmTarget: 3,
    });

    // Get a pre-warmed sandbox by session ID
    const sessionId = request.headers.get('x-session-id') || 'default';
    const sandbox = await pool.getContainer(sessionId);

    // Execute code in the sandbox
    const result = await sandbox.exec('python3 -c "print(2 + 2)"');
    return Response.json({ output: result.stdout });
  }
};
```
