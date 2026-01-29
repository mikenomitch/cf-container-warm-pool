# cf-container-warm-pool

A warm pool manager for [Cloudflare Containers](https://developers.cloudflare.com/containers/) and the [Sandbox SDK](https://github.com/cloudflare/sandbox-sdk). Pre-warm containers and acquire them on-demand with automatic lifecycle management.

This library pre-warms containers to reduce cold start times for end users. You can use it to start containers ahead of time and run any necessary setup before requests arrive.

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
import { createWarmPool, getWarmPool, WarmPool } from 'cf-container-warm-pool';

// Define your container with optional (but recommended) onStop handler
export class MyContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '10m';

  // RECOMMENDED: Notify the pool immediately when this container stops
  async onStop() {
    const pool = getWarmPool(this.env.WARM_POOL);
    await pool.reportStopped(this.ctx.id.toString());
  }
}

// Export the WarmPool DO
export { WarmPool };

// Use in your Worker
export default {
  async fetch(request: Request, env: Env) {
    const pool = createWarmPool(env.WARM_POOL, env.CONTAINER, {
      warmTarget: 3,
    });

    // Get a container by ID (1:1 mapping, sticky sessions)
    const sessionId = request.headers.get('x-session-id') || 'default';
    const container = await pool.getContainer(sessionId);
    return container.fetch(request);
  }
};
```

## Recommended: Container `onStop` Handler

Implement `onStop()` in your container class to notify the pool immediately when a container stops:

```ts
export class MyContainer extends Container<Env> {
  async onStop() {
    const pool = getWarmPool(this.env.WARM_POOL);
    await pool.reportStopped(this.ctx.id.toString());
  }
}
```

This is optional but preferred - it allows the pool to immediately remove stopped containers and replenish warm ones without waiting for the next health check.

As a fallback, the pool runs health checks each `refreshInterval` using the Container's built-in `getState()` method. This catches containers that stopped without reporting (e.g., if `onStop()` failed or wasn't implemented).

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
      // Your existing container binding
      { "class_name": "MyContainer", "name": "CONTAINER" },
      // Add this new binding for the warm pool
      { "class_name": "WarmPool", "name": "WARM_POOL" }
    ]
  },

  "migrations": [
    // Your existing container migration - skip if you already have this
    { "tag": "v1", "new_sqlite_classes": ["MyContainer"] },
    // Add this new migration for the warm pool
    { "tag": "v2", "new_sqlite_classes": ["WarmPool"] }
  ]
}
```

## API

### `createWarmPool(poolNamespace, containerNamespace, config?)`

Creates a warm pool client.

**Config options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `warmTarget` | number | 5 | Target number of warm (unassigned) containers to maintain ready for immediate use |
| `refreshInterval` | number | 30000 | How often to replenish warm containers (ms) |
| `poolName` | string | 'global-pool' | Name of the pool instance. Use this if you have multiple container types and need separate warm pools. |

### `getWarmPool(poolNamespace, poolName?)`

Get the WarmPool Durable Object stub. Use this in your container's `onStop()` to call `reportStopped()`.

```ts
const pool = getWarmPool(this.env.WARM_POOL);
await pool.reportStopped(this.ctx.id.toString());
```

If using multiple pools, pass the same `poolName` you used in `createWarmPool`:

```ts
const pool = getWarmPool(this.env.WARM_POOL, 'my-custom-pool');
await pool.reportStopped(this.ctx.id.toString());
```

### `pool.getContainer(id)`

Get a container by ID.

- If this ID already has an assigned container, returns the same container (1:1 mapping)
- If not, assigns a warm container from the pool
- If no warm containers available, starts a new one

```ts
const container = await pool.getContainer('user-session-123');
const response = await container.fetch(request);
```

### `pool.stats()`

Get current pool statistics.

```ts
const stats = await pool.stats();
// { warm: 3, assigned: 2, total: 5, config: {...} }
```

### `pool.shutdownPrewarmed()`

Stop all pre-warmed (unassigned) containers. Does not affect containers that are assigned to user IDs.

```ts
await pool.shutdownPrewarmed();
```

## How It Works

1. **Pre-warming**: The pool maintains `warmTarget` containers ready for immediate use

2. **1:1 mapping**: `getContainer(id)` always returns the same container for the same ID - no sharing between IDs

3. **Automatic assignment**: If no container is assigned to an ID, a warm one is taken from the pool

4. **Container lifecycle**: Containers manage their own lifecycle via `sleepAfter`. When they stop, `onStop()` notifies the pool

5. **Health checks**: Each refresh interval, the pool checks all tracked containers via `isRunning()` (if implemented) and removes any that have stopped

6. **Pool refresh**: A background alarm replenishes warm containers to maintain `warmTarget`

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

This library also works with the [Sandbox SDK](https://github.com/cloudflare/sandbox-sdk) (`@cloudflare/sandbox`). The Sandbox extends the Container class with methods for code execution, file operations, and more.

```ts
import { Sandbox } from '@cloudflare/sandbox';
import { createWarmPool, getWarmPool, WarmPool } from 'cf-container-warm-pool';

// Extend Sandbox with optional (but recommended) onStop handler
export class MySandbox extends Sandbox<Env> {
  async onStop() {
    const pool = getWarmPool(this.env.WARM_POOL);
    await pool.reportStopped(this.ctx.id.toString());
  }
}

export { WarmPool };

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

Your `wrangler.jsonc` for Sandbox:

```jsonc
{
  "containers": [
    {
      "class_name": "MySandbox",
      "image": "ghcr.io/cloudflare/sandbox:latest",
      "max_instances": 10
    }
  ],
  "durable_objects": {
    "bindings": [
      { "class_name": "MySandbox", "name": "SANDBOX" },
      { "class_name": "WarmPool", "name": "WARM_POOL" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MySandbox"] },
    { "tag": "v2", "new_sqlite_classes": ["WarmPool"] }
  ]
}
```

## Tradeoffs

**Increased cost.** Pre-warmed containers are billed while sitting idle in the pool. The more containers you keep warm (`warmTarget`), the higher your baseline cost. Consider your traffic patterns - if you have steady traffic, warm containers get used quickly. If traffic is bursty, you may pay for idle time between bursts.

**Auto-generated container IDs.** The pool generates UUIDs for container instances rather than using predictable names. This can make observability slightly harder since you can't easily correlate a container ID to a specific user session from logs alone. The pool maintains the mapping between your user-provided IDs and container UUIDs, but this mapping is internal to the pool's storage.

## License

MIT
