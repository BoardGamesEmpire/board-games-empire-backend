# Redis / Valkey / Dragonfly — Self-Hoster Guide

> How BGE uses Redis-compatible data stores, what each connection is for,
> and how to configure them in your deployment.

## Compatible servers

BGE speaks the Redis protocol and should work with any server that implements
it. **Only Redis is actually exercised.** The e2e suite provisions a stock Redis
container and nothing in CI starts anything else, so every other row below is
expectation rather than measurement. Written that way on purpose: this table
used to be headed "Tested deployments" over three ticks, which was true of the
first row only.

| Server                   | Status               | Notes                                                               |
| ------------------------ | -------------------- | ------------------------------------------------------------------- |
| Redis OSS                | ✅ Tested            | Reference implementation; the container the e2e suite runs against  |
| Redis Stack / Enterprise | ⚠ Expected, untested | Redis OSS plus modules and tooling; nothing in CI starts either     |
| Valkey                   | ⚠ Expected, untested | What the cache client (`iovalkey`) targets; AWS ElastiCache default |
| Dragonfly                | ⚠ Expected, untested | Multi-threaded; see the queue-naming and Streams notes below        |
| KeyDB                    | ⚠ Expected, untested | Multi-threaded Redis fork                                           |
| Garnet                   | ⚠ Expected, untested | Microsoft's durable cache/store                                     |

Verifying these — and restoring a ✅ where one is earned — is tracked in #462.
If you run BGE against any of them, that issue is where the evidence goes.

Mixing implementations is fine — see [Split-server deployments](#split-server-deployments).

## Connection topology

BGE uses **three logical databases**, each with its own purpose and isolation
guarantees. They can live on the same Redis server (default), on three
different servers, or any combination.

| Database | Default `db:` | Purpose                                                                          | Client library                |
| -------- | ------------- | -------------------------------------------------------------------------------- | ----------------------------- |
| Cache    | `0`           | App-level cache, gateway config events pub/sub, health checks, **rate limiting** | `iovalkey` (via `@bge/redis`) |
| Sockets  | `1`           | Socket.IO streams adapter for cross-instance WebSocket events                    | `node-redis`                  |
| Queue    | `2`           | BullMQ jobs (game imports, enrichment, fan-out)                                  | `iovalkey`                    |

Rate-limit counters share the cache connection rather than opening a fourth
(#341). They are small, short-lived and namespaced under `bge:throttle:`, and a
dedicated connection would cost a socket per process to isolate keys a prefix
already separates. One consequence worth knowing: **`FLUSHDB` on the cache
database clears rate-limit buckets too.** Harmless in development, and a way to
unstick a wrongly-blocked caller in production — but it is not a targeted
operation, and it resets every other caller's budget with it.

### Why three databases?

**Cache and queue must be isolated** because BullMQ uses blocking commands
(`BRPOP`) on its connection. If cache and queue shared a connection, every
worker waiting on a job would hold the cache connection captive. Separation
also makes it possible to `FLUSHDB` the cache for a forced refresh without
losing in-flight queue jobs.

**Sockets are isolated** because the Socket.IO streams adapter uses blocking
`XREAD BLOCK` calls — same reasoning as queue blocking commands. Additionally,
the streams adapter requires `node-redis` specifically (the other connections
use `iovalkey`), so it cannot share a client even when it could share a database.

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
REDIS_WEBSOCKET_DATABASE=1

# Queue → Dragonfly
REDIS_BULLMQ_HOST=dragonfly.internal
REDIS_BULLMQ_PORT=6379
REDIS_BULLMQ_DATABASE=2
```

Note that database indices need not match across servers — each connection's
`*_DATABASE` is independent.

### Managed cache, self-hosted queue and sockets

Use AWS ElastiCache (Valkey) for cache and run Valkey/Dragonfly locally for
queue and sockets. Or any other mix that fits your infrastructure.

## Process roles

The two `iovalkey` connections managed by `@bge/redis` (`CACHE_REDIS_CLIENT`
and `QUEUE_REDIS_CLIENT`) are **independently optional** at the
`RedisModule.forRootAsync` level. This is not a feature-toggle mechanism —
both connections are required for full system functionality — but a way for
each process role to configure only the connections it uses.

A server runs four process roles: api, worker, gateway worker and
coordinator. A process runs exactly one of them: the launcher refuses a
`BGE_ROLES` that names more than one, and there the gateway worker's role is
named `gateway-fetch`. The `split` deployment profile runs each role in its
own container (see [DEPLOYMENT.md](DEPLOYMENT.md)); an all-in-one deployment
profile, running several roles in one process, is planned (#200).

| Process role   | Cache       | Queue                  | Sockets |
| -------------- | ----------- | ---------------------- | ------- |
| api            | ✅ required | ✅ required (producer) | ✅      |
| worker         | ✅ required | ✅ required            | ❌      |
| gateway worker | ✅ required | ✅ required            | ❌      |
| coordinator    | ✅ required | ✅ required (producer) | ❌      |

Every role reads the same `REDIS_*` and `REDIS_BULLMQ_*` variables (the api
also reads `REDIS_WEBSOCKET_*`). A variable left unset takes its default —
`localhost`, `6379` and the database index shown above — so set the blocks in
every role's environment, not only the api's.

For horizontal scaling, run more worker or gateway worker processes beside
one or more api processes.

### Worker

The worker runs the server's background jobs: it consumes game imports
(`{bge.games.import}`), webhook and feedback deliveries, and the media sweep.
It configures the cache as well: it backs the worker's cache store and
carries the outbound HTTP policy's update channel, which webhook delivery
follows.

### Gateway worker

The gateway worker fetches games from DataGateways for imports. It calls
each DataGateway directly over gRPC, through the gateway registry; it never
calls the coordinator. It needs **both** Redis connections:

- **Cache** — for gateway registry pub/sub. The gateway worker listens for
  DataGateway config events (added, changed, removed, disabled) on the cache
  connection's pub/sub channel, and publishes one when it auto-disables a
  DataGateway after repeated failures.
- **Queue** — it consumes fetch jobs from `{bge.gateway.fetch}`, whose
  results the worker's import jobs read, and enqueues webhook deliveries for
  the import events it emits.

### Coordinator

The coordinator is the BGE gRPC service that carries live DataGateway
traffic for the api: searches, fetching one game, and starting imports. It
needs **both** Redis connections:

- **Cache** — for gateway registry pub/sub. The coordinator listens for
  DataGateway config events (added, changed, removed, disabled) on the cache
  connection's pub/sub channel, and publishes one when it auto-disables a
  DataGateway after repeated failed connections.
- **Queue** — for BullMQ producer-side work. When the api starts an import,
  the coordinator enqueues the game-import flow via `FlowProducer`, which
  uses the queue connection.

The coordinator does NOT use the sockets connection — only the api serves
WebSocket clients.

### The worker and gateway worker are not optional

An import runs in both: the gateway worker fetches the game from its
DataGateway, and the worker writes it to the database. Without at least one
gateway worker process, fetch jobs accumulate in the queue and no import
finishes; without at least one worker process, imports, webhook deliveries
and feedback deliveries accumulate and never run. Search needs neither: it
goes from the api through the coordinator. Run at least one of each.

### DataGateways are independent services

Remote DataGateways (BGG, IGDB, a planned Steam DataGateway, or third-party
implementations) are separate services that the coordinator and the gateway
worker call over gRPC. They do not use `@bge/redis` and are not part of the
process roles described here. A DataGateway's infrastructure choices are its
own concern.

A self-hoster who does not need game search/import functionality can run
BGE without any DataGateways at all. At least one DataGateway (of any
implementation) is required for game search and import to function.

## Server-specific notes

### BullMQ queue naming — the curly braces

BullMQ queue names in BGE are wrapped in curly braces (`{bge.games.import}`,
`{bge.gateway.fetch}`). Braces are **Redis Cluster hash tags**, a Redis feature
that Valkey Cluster implements identically: when a key contains `{...}`, only the
substring inside the braces is hashed to pick a slot, which is how multi-key
operations are kept on one node.

On a **standalone** server — which is every deployment this document describes —
braces are ordinary characters in a key name and change nothing.

Dragonfly reuses the same bracketed portion for **thread affinity**, so each
queue's commands land on one core. That is an additional Dragonfly-specific
effect rather than the reason the braces are there, and it is taken from
Dragonfly's own documentation, never measured here (#462).

> **If you run clustered Redis or Valkey, read this.** BGE neither configures nor
> tests clustered mode. The two queue names above carry **different** hash tags,
> so their keys hash to different slots — and the game-import flow spans both
> queues through a single `FlowProducer.add`, which is a multi-key operation.
> Under a cluster that combination raises `CROSSSLOT`. Running BGE clustered
> needs the flow's queues brought under one tag first; the braces as they stand
> do not make BGE cluster-compatible.
>
> The queues are not the only place. The rate limiter
> (`apps/api/src/app/lib/redis-throttler.storage.ts`) passes its Lua **two**
> keys — a hit counter and a block marker, `<counter>:blocked` — and neither
> carries a hash tag, so nothing colocates them. A slot is `CRC16` of the whole
> key name, and the two names differ, so all but roughly one bucket in 16384
> straddles two slots and raises `CROSSSLOT`. Not "sometimes": the two slots for
> a given route-and-tracker pair are fixed, so a bucket raises it on every
> request or on none, and which one it is does not change while the key format
> does not.
>
> The storage fails open on an error it cannot read, so clustered mode would not
> break the API — it would serve 200s with nothing limiting them. The only
> signal is one gated `Rate-limit storage unavailable` line per interval, which
> is also what an unreachable Redis produces, so the logs do not distinguish a
> cluster nobody supports from a server that is down. Bracketing the variable
> part of both keys fixes it, and is deliberately not done while clustered mode
> is untested — it changes the key format for a topology nothing here runs.
>
> The permission-graph cache is a third. It reads a graph and that graph's
> version token in one `MGET` (`PermissionsService.getOrLoad`), and the two
> keys share no hash tag. Under a cluster the read raises `CROSSSLOT`, the cache
> library reports it as a miss without logging anything, and every request
> loads its caller's graph from Postgres. Nothing stale is served; the cache is
> simply off. The same fix applies, held back for the same reason.

### Dragonfly — Streams edge cases

Dragonfly's streams implementation is **expected** to handle the BGE workload
(Socket.IO cross-instance event distribution), but that has not been verified
here — no BGE test has run against Dragonfly at any scale (#462). If you operate
at high WebSocket throughput (thousands of concurrent connections, sustained
high event rates), read the Dragonfly migration guide for stream-related caveats
rather than relying on this paragraph.

### Valkey — no caveats expected

Valkey is the closest drop-in replacement for Redis, and the cache client
(`iovalkey`) is written for it, so every BGE component is expected to work
against Valkey identically. "No caveats" is a prediction rather than a result —
like the rest of the table, it is untested here (#462). AWS ElastiCache
Serverless defaults to Valkey as of 2025.

## Library choices

BGE deliberately uses two different Node.js Redis client libraries:

- **`iovalkey`** for cache, queue, health-check and rate-limit connections. A
  Valkey-focused fork of `ioredis` with the same options and command surface —
  which is what BullMQ requires; the others consolidate on it.
- **`node-redis`** for the Socket.IO streams adapter. Required by
  `@socket.io/redis-streams-adapter`; not used anywhere else.

`iovalkey` is the package actually installed. `ioredis` appears in the tree only
as a transitive dependency of BullMQ and `@nestjs/microservices`, so a library
typed against `ioredis` needs a cast to accept a `@bge/redis` client — the
reason `RedisThrottlerStorage` implements `ThrottlerStorage` itself rather than
using `@nest-lab/throttler-storage-redis` (#341).

This is not a portability constraint — it is a pragmatic constraint imposed
by the upstream libraries.

## Internal architecture (developer reference)

The shared `iovalkey` connections are owned by `@bge/redis`'s `RedisModule` and
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
it requires `node-redis` rather than `iovalkey` and has different lifecycle
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

| Process        | iovalkey (cache) | iovalkey (queue) | node-redis (sockets) | BullMQ workers                 |
| -------------- | ---------------- | ---------------- | -------------------- | ------------------------------ |
| Main API       | 1                | 1                | 1                    | 0                              |
| Coordinator    | 1                | 1 producer       | 0                    | 0                              |
| Worker         | 1                | 1 producer       | 0                    | 1 blocking per worker instance |
| Gateway worker | 1                | 1 producer       | 0                    | 1 blocking per worker instance |

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
