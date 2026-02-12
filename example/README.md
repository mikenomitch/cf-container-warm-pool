# Warm Pool Example

A complete example demonstrating the warm pool pattern with Cloudflare Containers.

## Setup

```bash
npm install
```

### Configure KV cache (required for this example)

Create a KV namespace for `CONTAINER_ID_CACHE` and update `wrangler.jsonc`:

```bash
wrangler kv namespace create CONTAINER_ID_CACHE
wrangler kv namespace create --preview CONTAINER_ID_CACHE
```

Replace `<kv-id>` and `<kv-preview-id>` in `example/wrangler.jsonc` with the returned IDs.

## Development

```bash
npm run dev
```

## Endpoints

- `GET /` - Proxies request to a container from the warm pool
- `GET /stats` - Shows pool statistics (warm, acquired, warming counts)
- `POST /warmup` - Manually triggers container warmup
- `POST /shutdown` - Stops all containers in the pool

## Deploy

```bash
npm run deploy
```

## How it Works

1. The Worker exports two Durable Objects:
   - `MyContainer` - Your container (extends `@cloudflare/containers`)
   - `WarmPool` - Manages the pool of pre-warmed containers

2. On first request, the pool warms up `minContainers` containers

3. When you call `pool.acquire()`, it returns an already-warm container immediately

4. After `release()`, the container returns to the warm pool for reuse

5. A background alarm periodically health-checks containers and replenishes the pool
