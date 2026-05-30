# Redis / Valkey / Dragonfly — Self-Hoster Guide

> How BGE uses Redis-compatible data stores, what each connection is for,
> and how to configure them in your deployment.

## Compatible servers

BGE works with any Redis-protocol-compatible server. Tested deployments:

| Server                           | Status                   | Notes                                        |
| -------------------------------- | ------------------------ | -------------------------------------------- |
| Redis (OSS / Stack / Enterprise) | ✅ Supported             | Reference implementation                     |
| Valkey                           | ✅ Supported             | Drop-in replacement; AWS ElastiCache default |
| Dragonfly                        | ✅ Supported             | Multi-threaded; see queue naming note below  |
| KeyDB                            | ⚠ Likely works, untested | Multi-threaded Redis fork                    |
| Garnet                           | ⚠ Likely works, untested | Microsoft's durable cache/store              |

Mixing implementations is fine — see [Split-server deployments](#split-server-deployments).

## Connection topology

BGE uses **three logical databases**, each with its own purpose and isolation
guarantees. They can live on the same Redis server (default), on three
different servers, or any combination.

| Database | Default `db:` | Purpose                                                       | Client library               |
| -------- | ------------- | ------------------------------------------------------------- | ---------------------------- |
| Cache    | `0`           | App-level cache, gateway config events pub/sub, health checks | `ioredis` (via `@bge/redis`) |
| Sockets  | `1`           | Socket.IO streams adapter for cross-instance WebSocket events | `node-redis`                 |
| Queue    | `2`           | BullMQ jobs (game imports, enrichment, fan-out)               | `ioredis`                    |

### Why three databases?

**Cache and queue must be isolated** because BullMQ uses blocking commands
(`BRPOP`) on its connection. If cache and queue shared a connection, every
worker waiting on a job would hold the cache connection captive. Separation
also makes it possible to `FLUSHDB` the cache for a forced refresh without
losing in-flight queue jobs.

**Sockets are isolated** because the Socket.IO streams adapter uses blocking
`XREAD BLOCK` calls — same reasoning as queue blocking commands. Additionally,
the streams adapter requires `node-redis` specifically (the other connections
use `ioredis`), so it cannot share a client even when it could share a database.

## Configuration — single server (default)

The simplest deployment runs one Redis-compatible server and BGE points all
three databases at it:

```bash
# Cache (db:0)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DATABASE=0

# Sockets (db:1)
REDIS_WEBSOCKET_HOST=localhost
REDIS_WEBSOCKET_PORT=6379
REDIS_WEBSOCKET_DATABASE=1

# Queue (db:2)
REDIS_BULLMQ_HOST=localhost
REDIS_BULLMQ_PORT=6379
REDIS_BULLMQ_DATABASE=2
```

Each block also supports authentication and TLS:

```bash
REDIS_USERNAME=bge
REDIS_PASSWORD=secret
REDIS_TLS_ENABLED=true
REDIS_TLS_CA=/etc/ssl/redis-ca.pem
REDIS_TLS_CERT=/etc/ssl/redis-cert.pem
REDIS_TLS_KEY=/etc/ssl/redis-key.pem
REDIS_REJECT_UNAUTHORIZED=true
```

Replace the `REDIS_` prefix with `REDIS_WEBSOCKET_` or `REDIS_BULLMQ_` for the
other connections.

## Split-server deployments

Each connection can target a different server entirely. Common combinations:

### Dragonfly for cache + queue, Valkey for sockets

Dragonfly's multi-core performance benefits cache and queue throughput.
Valkey's mature streams implementation handles the Socket.IO adapter.

```bash
# Cache → Dragonfly
REDIS_HOST=dragonfly.internal
REDIS_PORT=6379
REDIS_DATABASE=0

# Sockets → Valkey
REDIS_WEBSOCKET_HOST=valkey.internal
REDIS_WEBSOCKET_PORT=6379
REDIS_WEBSOCKET_DATABASE=0

# Queue → Dragonfly
REDIS_BULLMQ_HOST=dragonfly.internal
REDIS_BULLMQ_PORT=6379
REDIS_BULLMQ_DATABASE=1
```

Note that database indices need not match across servers — each connection's
`*_DATABASE` is independent.

### Managed cache, self-hosted queue and sockets

Use AWS ElastiCache (Valkey) for cache and run Valkey/Dragonfly locally for
queue and sockets. Or any other mix that fits your infrastructure.

## Deployment topologies

The two ioredis connections managed by `@bge/redis` (`CACHE_REDIS_CLIENT`
and `QUEUE_REDIS_CLIENT`) are **independently optional** at the
`RedisModule.forRootAsync` level. This is not a feature-toggle mechanism —
both connections are required for full system functionality — but a
deployment topology mechanism that lets you split work across processes.

| Topology                              | Cache      | Queue       | Sockets |
| ------------------------------------- | ---------- | ----------- | ------- |
| Combined: API + worker in one process | ✅         | ✅          | ✅      |
| Split: API process                    | ✅         | ✅          | ✅      |
| Split: dedicated worker process       | optional\* | ✅ required | ❌      |
| Coordinator (BGE gRPC service)        | ❌         | ❌          | ❌      |

\* Worker processes consume queue jobs. They configure `cache` only if their
job handlers read or write cached data — e.g. the game-import worker reads
cached gateway responses. If a worker process never touches cache, omit it.

### Combined deployment (default)

The simplest deployment runs the API and worker in a single process. This
is what the default `apps/api` configuration produces. Both connections are
configured because the same process runs both the HTTP layer and BullMQ
workers.

### Split deployment

For horizontal scaling, run dedicated worker processes alongside one or
more API processes. The worker process configures only the connections it
needs:

```bash
# Worker — typically only needs queue, plus cache for job handlers
REDIS_BULLMQ_HOST=valkey.internal
REDIS_BULLMQ_PORT=6379
REDIS_BULLMQ_DATABASE=2

# Optional — cache config block only if job handlers touch cache
REDIS_HOST=valkey.internal
REDIS_PORT=6379
REDIS_DATABASE=0

# Cache env vars omitted entirely if not needed — CACHE_REDIS_CLIENT is
# then not registered, and any code path attempting to inject it will fail
# fast at module init with a clear "No provider found" error.
```

### Workers are not optional

Workers consume queue jobs. Without at least one worker process (combined
or separate), game imports, enrichment, and fan-out jobs will accumulate
in the queue and never run. A deployment without workers is technically
possible but severely degrades the system — search and import will be
unusable. Either run the combined deployment (workers in the API process)
or run dedicated worker processes.

### Gateways are independent services

Game-data gateways (BGG, IGDB, Steam, or third-party implementations) are
separate processes that communicate with the BGE coordinator via gRPC.
They do not use `@bge/redis` and are not part of the topology described
here. A gateway's infrastructure choices are its own concern.

A self-hoster who does not need game search/import functionality can run
BGE without any gateways at all. At least one gateway (of any
implementation) is required for game search and import to function.

## Server-specific notes

### Dragonfly — BullMQ queue naming

BullMQ queue names in BGE are wrapped in curly braces (e.g. `{game-import}`).
This is **a Dragonfly-specific optimisation**: Dragonfly uses the bracketed
portion of a key to derive a hash slot for thread affinity, allowing each
queue's commands to run on a dedicated CPU core.

The braces have **no effect on Redis or Valkey** — they are treated as
ordinary characters in key names. There is no performance penalty for using
braces on non-Dragonfly servers, so the convention is applied unconditionally.

### Dragonfly — Streams edge cases

Dragonfly's streams implementation handles the BGE workload (Socket.IO
cross-instance event distribution) without issue at typical scales. If you
operate at very high WebSocket throughput (thousands of concurrent
connections, sustained high event rates), monitor the Dragonfly migration
guide for stream-related caveats.

### Valkey — no caveats

Valkey is the closest drop-in replacement for Redis. Every BGE component
works against Valkey identically to Redis. AWS ElastiCache Serverless
defaults to Valkey as of 2025.

## Library choices

BGE deliberately uses two different Node.js Redis client libraries:

- **`ioredis`** for cache, queue, and health-check connections. Required by
  BullMQ; selected for the other two to consolidate around a single client.
- **`node-redis`** for the Socket.IO streams adapter. Required by
  `@socket.io/redis-streams-adapter`; not used anywhere else.

The cache uses `@keyv/valkey` (backed by `iovalkey`, an ioredis-compatible
client) so it shares the ioredis ecosystem despite the package name.

This is not a portability constraint — it is a pragmatic constraint imposed
by the upstream libraries.

## Internal architecture (developer reference)

The shared ioredis connections are owned by `@bge/redis`'s `RedisModule` and
exposed via injection tokens. Both tokens are **independently optional** —
configured per-process via `RedisModule.forRootAsync`:

- `CACHE_REDIS_CLIENT` — used by `CacheModule`, `GatewayConfigEventsModule`,
  and `HealthModule`. Registered when `cache` is passed to `forRootAsync`.
  Configured with `maxRetriesPerRequest: 3` for fail-fast cache semantics.
- `QUEUE_REDIS_CLIENT` — used by BullMQ `Queue` and `FlowProducer` instances.
  Registered when `queue` is passed to `forRootAsync`. Configured with
  `maxRetriesPerRequest: null` per BullMQ requirements.

A `RedisLifecycleManager` provider coordinates graceful `quit()` on the
configured clients during application shutdown. Both clients are injected as
`@Optional()`, so the manager works correctly regardless of which subset of
connections is registered.

BullMQ **workers** create an additional blocking connection per worker
process. This is internal to BullMQ and cannot be shared.

The Socket.IO streams adapter connection is managed in
`apps/api/src/app/adapters/redis-io.adapter.ts` outside the shared module —
it requires `node-redis` rather than ioredis and has different lifecycle
requirements than the queue and cache connections.

### Future considerations

**Optional WebSockets for lean deployments.** WebSockets are currently
always-on. Single-user self-hosters who don't use game-night events or
live updates could benefit from making WebSockets optional to drop the
node-redis connection, free up the websocket Redis database, and eliminate
the streams adapter polling overhead. This is tracked as a post-alpha
optimization. The cleanest path would be wrapping all WebSocket concerns
(gateways, adapter, emit helpers) behind a `RealtimeModule` toggled by a
single config flag, rather than scattering conditionals across the codebase.

## Troubleshooting

### Cache returns stale data after Redis restart

Expected. `@keyv/valkey` writes are durable only if your Redis instance is
configured for persistence (AOF or RDB). For BGE, cache is treated as
recomputable — losing it on restart is fine.

### BullMQ workers hang on shutdown

Workers use blocking `BRPOP` and may take up to the `lockDuration` to release
their lock on shutdown. Set `lockDuration` lower in dev if startup-shutdown
cycles feel slow.

### "ERR max number of clients reached"

Per-process connection counts depend on which connections are configured:

| Process  | ioredis (cache)              | ioredis (queue) | node-redis (sockets) | BullMQ workers                 |
| -------- | ---------------------------- | --------------- | -------------------- | ------------------------------ |
| Main API | 1                            | 1               | 1                    | 0                              |
| Worker   | 0 (or 1 if cache configured) | 1 producer      | 0                    | 1 blocking per worker instance |

Default Redis `maxclients` is 10000 — well above typical needs even with
many worker replicas. Check `CLIENT LIST` to see who's connected; the BGE
connections appear with `name=bge`.

### Health check fails but app works

The cache connection — which the health indicator shares with the cache and
gateway registry — uses `maxRetriesPerRequest: 3` (fail-fast). If
`/health/ready` reports Redis down but other functionality still works, the
underlying Redis is intermittently reachable but slow enough that the
health probe gives up. Investigate network or server health.

### "No provider found for Symbol(CACHE_REDIS_CLIENT)" at startup

The process is trying to use the cache connection but `RedisModule.forRootAsync`
was bootstrapped without a `cache` block. Either add the cache configuration,
or remove the code path that injects `CACHE_REDIS_CLIENT` from this process.
The same applies to `QUEUE_REDIS_CLIENT`.

### "RedisModule.forRootAsync requires at least one of `cache` or `queue`"

The module was imported with an empty options object. Either configure at
least one connection, or remove the `RedisModule` import — processes that
need neither connection should not import the module at all.
