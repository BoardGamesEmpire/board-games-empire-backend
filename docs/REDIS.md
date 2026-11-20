# Redis / Valkey / Dragonfly — Self-Hoster Guide

> How BGE uses Redis-compatible data stores, what each connection is for,
> and how to configure them in your deployment.

## Compatible servers

BGE speaks the Redis protocol and should work with any Redis-compatible server.
The api e2e suite runs on each setup below that has a name: the `e2e` job in
`.github/workflows/ci.yml` runs it on Redis for every pull request that affects
the api, and [`.github/workflows/redis-compat.yml`](../.github/workflows/redis-compat.yml) runs it on the others weekly,
and on demand. A setup stays in those jobs only while the suite passes on it in
full. In the Status column:

- **✅ Tested**: the suite passes, and no measured gap is known.
- **⚠ with a reason**: the suite passes, but a measured gap remains, named in
  the row.
- **⚠ Expected, untested**: nothing has been run, so the row is expectation
  rather than measurement.

The suite runs the api, and a worker where a spec needs one, with all three
connections (see [Connection topology](#connection-topology)) on the one
Redis-compatible server, each on its own logical database on every setup,
including `dragonfly-hashtags` (its emulated cluster mode accepted `SELECT` on a
database other than 0: the queue ran on db 2). It shows what passes there, not
how fast: it is not a load test, and no speed was measured on any setup.

The suite starts neither the coordinator nor the gateway worker, so it runs no
game import. The game-import flow was probed on its own instead (2026-11-16,
BullMQ 5.81): a parent job on `{bge.games}.import` with its fetch child on
`{bge.games}.fetch`, each completed by a BullMQ worker. The table's
"Game-import flow" column gives what that probe found.

| Server                   | Suite setup                 | Status               | Game-import flow (probed) | Notes                                                                                                                                                                                      |
| ------------------------ | --------------------------- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Redis OSS 7              | `redis`                     | ✅ Tested            | ✅ Completes              | Reference implementation; the default, and what `ci.yml` runs                                                                                                                              |
| Valkey 9.0               | `valkey`                    | ✅ Tested            | ✅ Completes              | What the cache client (`iovalkey`) targets; AWS ElastiCache default                                                                                                                        |
| KeyDB 6.3                | `keydb`                     | ✅ Tested            | ✅ Completes              | Multi-threaded Redis fork; see [KeyDB](#keydb--two-limits-bge-works-around)                                                                                                                |
| Dragonfly 2.1            | `dragonfly-undeclared-keys` | ✅ Tested            | ✅ Completes              | Run with `--default_lua_flags=allow-undeclared-keys`; by Dragonfly's account, each script locks the whole store                                                                            |
| Dragonfly 2.1            | `dragonfly-hashtags`        | ✅ Tested            | ✅ Completes              | Run with `--cluster_mode=emulated --lock_on_hashtags`; every queue name carries a hash tag, and a flow's queues share one (see [the curly braces](#bullmq-queue-naming--the-curly-braces)) |
| Redis Stack / Enterprise | —                           | ⚠ Expected, untested | Untested                  | Redis OSS plus modules and tooling; nothing in CI starts either                                                                                                                            |
| Garnet                   | —                           | ⚠ Expected, untested | Untested                  | Microsoft's durable cache/store                                                                                                                                                            |

Dragonfly with neither flag set refuses a Lua script that reaches a key the
script was not given, and BullMQ's scripts do: probed with no flags, it refused
to add even a single job. It needs one of the two flag sets; see
[Dragonfly for cache + queue](#dragonfly-for-cache--queue-valkey-for-sockets).
`apps/api-e2e/src/support/redis-server.ts` names the image each setup starts.
Each is pinned to one version, except Redis's `redis:7-alpine`, which follows
the latest Redis 7.

To run the suite on one of them yourself, name its setup in
`BGE_E2E_REDIS_SERVER` ([`apps/api-e2e/README.md`](../apps/api-e2e/README.md)
lists the names). Unset, it is `redis`. Like every run of the suite, it needs a
running Docker daemon:

```sh
BGE_E2E_REDIS_SERVER=valkey npm run nx -- e2e @boardgamesempire/api-e2e
```

Each connection can point at a different Redis-compatible server — see
[Split-server deployments](#split-server-deployments).

## Connection topology

BGE uses **three logical databases**, each with its own purpose and isolation
guarantees. They can live on the same Redis server (default), on three
different servers, or any combination.

| Database | Default `db:` | Purpose                                                                                                                                                 | Client library                |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Cache    | `0`           | App-level cache, **sign-in sessions**, pub/sub for DataGateway config, outbound HTTP policy and plugin config updates, health checks, **rate limiting** | `iovalkey` (via `@bge/redis`) |
| Sockets  | `1`           | Socket.IO streams adapter for cross-instance WebSocket events                                                                                           | `node-redis`                  |
| Queue    | `2`           | BullMQ jobs (game imports, enrichment, fan-out)                                                                                                         | `iovalkey`                    |

Rate-limit counters share the cache connection rather than opening a fourth
(#341). They are small, short-lived and namespaced under `bge:throttle:`, and a
dedicated connection would cost a socket per process to isolate keys a prefix
already separates. One consequence worth knowing: **`FLUSHDB` on the cache
database clears rate-limit buckets too.** Harmless in development, and a way to
unstick a wrongly-blocked caller in production — but it is not a targeted
operation, and it resets every other caller's budget with it. **It also signs
everyone out**: better-auth keeps sessions in the same database, under
`namespace:api:cache:auth_*`, for their full seven days (#640).

Permission graphs, which abilities are built from, and the version tokens that
guard them live under `namespace:permissions:cache:`. Every process reads that
one store, so an eviction in one process, or the api's boot flush, reaches the
graph every other process would read (#786). That holds only while every
process points its cache connection (`REDIS_HOST`, `REDIS_PORT`,
`REDIS_DATABASE`) at the same database: nothing checks it, and a process
pointed elsewhere keeps serving graphs the api evicted until their TTL ends,
up to five minutes. `FLUSHDB` clears them too, which costs each user and API
key one reload.

### Why three databases?

**Cache and queue must be isolated** because BullMQ uses blocking commands
(`BRPOP`) on its connection. If cache and queue shared a connection, every
worker waiting on a job would hold the cache connection captive. Separation
also makes it possible to `FLUSHDB` the cache for a forced refresh without
losing in-flight queue jobs, though it signs everyone out (see above).

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
REDIS_TLS_CA="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
REDIS_TLS_CERT="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
REDIS_TLS_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
REDIS_REJECT_UNAUTHORIZED=true
```

The certificates and the key are the PEM text itself, not paths to files.
Reading them from mounted files is planned (#466). The PEM needs its line
breaks, and how to write them depends on where the variable is set:

- **In a `.env` file**, write it on one line in double quotes, with `\n` for
  each line break, as above. The double quotes are what turn `\n` into a line
  break; without them it stays two characters.
- **In Compose's `environment:` or a Kubernetes manifest**, YAML decides. A
  double-quoted string turns `\n` into a line break, as a `.env` file does, and
  a block scalar (`|`) takes the PEM's lines as they are. A Kubernetes Secret
  holding the PEM file works too.

Replace the `REDIS_` prefix with `REDIS_WEBSOCKET_` or `REDIS_BULLMQ_` for the
other connections.

## Split-server deployments

Each connection can target a different server entirely. Common combinations:

### Dragonfly for cache + queue, Valkey for sockets

The suite runs every connection on one Redis-compatible server, so it has not
run this mix as such. It passes with all three connections on Valkey, and with
all three on Dragonfly started with either flag set below.

Out of the box, Dragonfly refuses a Lua script that reaches a key the script was
not given, answering `script tried accessing undeclared key` (its
[scripting documentation](https://www.dragonflydb.io/docs/managing-dragonfly/scripting)
says so). BullMQ's scripts reach such keys: probed with no flags on 2026-11-16,
Dragonfly 2.1 refused to add even a single job. Dragonfly's
[BullMQ guide](https://www.dragonflydb.io/docs/integrations/bullmq) asks for one
of two flag sets, and the suite and the game-import flow pass on each:

- **`--default_lua_flags=allow-undeclared-keys`** (setup
  `dragonfly-undeclared-keys`). Lets every script reach any key. By Dragonfly's
  guide, it locks the whole store for each script and slows things down
  considerably. The game-import flow completes on it (probed).
- **`--cluster_mode=emulated --lock_on_hashtags`** (setup `dragonfly-hashtags`).
  By Dragonfly's documentation, it locks by hash tag instead of by key, each
  queue belongs to one thread, and queues on different tags can be worked on in
  parallel. The guide also asks that queues in a parent/child relationship
  share one tag, as the game-import queues do (`{bge.games}`), so the
  game-import flow completes on it (probed).

BGE has measured the speed of neither: the suite shows what passes on them,
not how fast.

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

Note that database indices need not match across Redis-compatible servers —
each connection's `*_DATABASE` is independent.

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
(`{bge.games}.import`), webhook and feedback deliveries, the media sweep, and
the extended network's rebuilds (`{bge.friendship.extended-network}`). It configures
the cache as well: it backs the worker's cache store and carries the outbound
HTTP policy's update channel, which webhook delivery follows.

The api queues to the worker too: each friendship change that can add or end
an accepted friendship queues a rebuild, which runs a couple of seconds
later. The worker queues a full rebuild when it starts and daily, which
runs a batch of users at a time and goes back to the queue between batches.
The rebuilds run one at a time across every worker, and a change's rebuild
runs before the full rebuild's next batch. While that queue is backed up, an
unfriend takes longer to take a user out of someone's extended network.

### Gateway worker

The gateway worker fetches games from DataGateways for imports. It calls
each DataGateway directly over gRPC, through the gateway registry; it never
calls the coordinator. It needs **both** Redis connections:

- **Cache** — for gateway registry pub/sub. The gateway worker listens for
  DataGateway config events (added, changed, removed, disabled) on the cache
  connection's pub/sub channel, and publishes one when it auto-disables a
  DataGateway after repeated failures.
- **Queue** — it consumes fetch jobs from `{bge.games}.fetch`, whose
  results the worker's import jobs read, and enqueues webhook deliveries for
  the import events it emits. It also consumes the list jobs on
  `{bge.gateway.vocabulary}`: after each interview, each one loads a
  DataGateway's languages, platforms, categories or mechanics. Both the
  gateway worker and the coordinator enqueue them after an interview, but
  only the gateway worker runs them.

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
  uses the queue connection. After an interview, it enqueues that
  DataGateway's list jobs on `{bge.gateway.vocabulary}`, which the gateway
  worker runs.

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

Every BullMQ queue name in BGE is wrapped in curly braces:

- `{bge.games}.import`
- `{bge.games}.fetch`
- `{bge.gateway.vocabulary}`
- `{bge.media.contribution-sweep}`
- `{bge.friendship.extended-network}`
- `{bge.mail.delivery}`
- `{bge.webhooks.delivery}`
- `{bge.feedback.delivery}`

Braces are **Redis Cluster hash tags**, a Redis feature that Valkey Cluster
implements identically: when a key contains `{...}`, only the substring inside
the braces is hashed to pick a slot, which is how multi-key operations are kept
on one node. BullMQ puts a queue's name in each of its keys
(`bull:{bge.games}.import:wait`, ...), so all of them share its tag.

A BullMQ flow adds a parent job and its children together, and the script that
adds a child reaches its parent's keys. So the queues of one flow share one
tag: the game import's parent and fetch child are on `{bge.games}.import` and
`{bge.games}.fetch`. See
[a flow's queues share one tag](#dragonfly--a-flows-queues-share-one-tag) for
what happens on Dragonfly when they don't.

The `Check BullMQ queue hash tags` step in `.github/workflows/ci.yml` keeps this
true on every pull request. It runs
`libs/scripts/src/bin/check-queue-hash-tags.js`, which finds every place in
`apps/` and `libs/` that registers or names a queue, and fails on a name with no
hash tag, or on one it cannot follow to a single string literal. It also fails
a flow child whose queue's tag differs from its parent's.

Plugin queues follow the same rule. Nothing registers a plugin's queues with
BullMQ yet; whatever does must register each one's full name in braces,
`{plugin.<slug>.<queue>}`, so its keys share one tag. The name can't contain a
`:`, because BullMQ refuses a queue name that has one, braced or not. The
manifest validator holds every plugin queue to `plugin.<slug>.<queue>`, with a
kebab-case `<queue>`, so each name it accepts can be registered.

This document describes standalone Redis-compatible servers only, not
clusters. On a **standalone** Redis, Valkey or KeyDB, braces are ordinary
characters in a key name and change nothing.

Dragonfly reads them in the
`dragonfly-hashtags` setup (`--cluster_mode=emulated --lock_on_hashtags`),
Dragonfly's documentation says it assigns each queue to a thread by the tag and
locks by the tag, and its BullMQ guide asks for hash-tagged queue names there,
with one shared tag for queues in a parent/child relationship. The suite passes
on that setup with these names, the game-import flow completes there (probed),
and nothing about speed was measured.

Emulated cluster mode is still a single Redis-compatible server, and it does
not raise `CROSSSLOT`: a cross-slot `MGET` and the rate limiter's two-key script
both succeed on it (probed 2026-11-16). So the two cases in the callout below
concern clustered Redis and Valkey only.

> **If you run clustered Redis or Valkey, read this.** BGE neither configures nor
> tests clustered mode, and its queue names alone do not make it
> cluster-compatible. Every queue's keys share a tag, and so do the game-import
> flow's two queues (`{bge.games}`), but two other places pass keys that share
> none.
>
> The rate limiter (`apps/api/src/app/lib/redis-throttler.storage.ts`) passes
> its Lua **two** keys — a hit counter and a block marker, `<counter>:blocked` — and neither
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
> The permission-graph cache is the other. It reads a graph and that graph's
> version token in one `MGET` (`PermissionsService.getOrLoad`), and the two
> keys share no hash tag. Under a cluster the read raises `CROSSSLOT`, the cache
> library reports it as a miss without logging anything, and every request
> loads its caller's graph from Postgres. Nothing stale is served; the cache is
> simply off. The same fix applies, held back for the same reason.

### Dragonfly — a flow's queues share one tag

A game import is a BullMQ flow: a parent job on `{bge.games}.import` with one
fetch child on `{bge.games}.fetch`
(`libs/api/game-import/src/lib/flows/import-flow.builder.ts`), and an
expansion's import has the same shape. Dragonfly's BullMQ guide says queues in a
parent/child relationship should share one hash tag, and these two do.

They once did not (`{bge.games.import}` and `{bge.gateway.fetch}`), and on the
`dragonfly-hashtags` setup that stopped every game import. Probed on 2026-11-16
(BullMQ 5.81, Dragonfly 2.1): adding the flow wrote the parent, but the script
that adds the child reached the parent's job key under the other tag and was
refused (`script tried accessing undeclared key`). BullMQ checks only the
parent's result, so the add succeeded with no error, the fetch job never
existed, and the import waited for it forever. The api e2e suite runs no game
import, so its pass on that setup did not show it.

With the shared tag, the same probe's flow completes on every setup in the
table. The queue hash-tag check fails a pull request that gives a flow child a
tag other than its parent's, since nothing else would notice.

### Dragonfly — Streams on one process

The suite passes with the Socket.IO streams adapter on Dragonfly, in both
setups, its WebSocket specs included. It runs one api process, though, so
nothing here has sent events from one api process to another through Dragonfly,
or run Dragonfly at high WebSocket throughput (thousands of concurrent
connections, sustained high event rates).

### Valkey — no caveats

Valkey 9.0 passes the suite with no Valkey-specific change in BGE. It is the
closest drop-in replacement for Redis, and the cache client (`iovalkey`) is
written for it. AWS ElastiCache Serverless defaults to Valkey as of 2025.

### KeyDB — two limits BGE works around

KeyDB 6.3 holds a command sent behind a `SCAN` of `COUNT` 100 or more on the
same connection until that connection sends again, so BGE scans with a `COUNT`
under 100. It is a fork of Redis 6 and rejects `PEXPIRE ... NX`, an option Redis
7.0 added, so BGE's Lua scripts don't use it.

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

- `CACHE_REDIS_CLIENT` — used by `CacheModule`, better-auth's storage
  (`createRedisAuthStorage` in `@bge/auth`), `GatewayConfigEventsModule`,
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

### Pending Steam sign-ins

Linking a Steam account as an upstream account starts a Steam sign-in, and the
cache connection keeps it until Steam sends the browser back (#935). Two keys:

- `bge:upstream-link:steam:state:<state>` holds the pending sign-in (user,
  return address, start time). It lives **30 minutes** and is removed when the
  return takes it, so a state works once.
- `bge:upstream-link:steam:user:<userId>` holds that user's current state, so
  starting again deletes the earlier one. It carries the same 30 minutes.

`FLUSHDB` on the cache database drops pending sign-ins; the user starts the
link again. The store needs `GETDEL` and `SET … GET`, which both need Redis 6.2
or later. The api e2e suite exercises them, so the redis-compat workflow checks
the compatible servers above in the same run.

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
recomputable — losing it on restart is fine. Sessions are the exception: they
live in the same database, so a Redis that loses its data signs everyone out.
`compose.yaml` turns on append-only persistence for that reason.

### BullMQ workers hang on shutdown

Workers use blocking `BRPOP` and may take up to the `lockDuration` to release
their lock on shutdown. Set `lockDuration` lower in dev if startup-shutdown
cycles feel slow.

### "ERR max number of clients reached"

Per-process connection counts depend on which connections are configured:

| Process        | iovalkey (cache) | iovalkey (cache subscribers) | iovalkey (queue) | node-redis (sockets) | BullMQ workers                 |
| -------------- | ---------------- | ---------------------------- | ---------------- | -------------------- | ------------------------------ |
| Main API       | 1                | 2                            | 1                | 1                    | 0                              |
| Coordinator    | 1                | 1                            | 1 producer       | 0                    | 0                              |
| Worker         | 1                | 1                            | 1 producer       | 0                    | 1 blocking per worker instance |
| Gateway worker | 1                | 1                            | 1 producer       | 0                    | 1 blocking per worker instance |

A subscriber is a dedicated connection: a client in subscribe mode can run no
other commands, so each update channel a process listens on gets its own
duplicate of the cache connection. The api listens for outbound HTTP policy
and plugin config updates, the worker for outbound HTTP policy updates, and
the coordinator and gateway worker for DataGateway config events.

Default Redis `maxclients` is 10000 — well above typical needs even with
many worker replicas. Check `CLIENT LIST` to see who's connected; the BGE
connections appear with `name=bge`.

### Health check fails but app works

The cache connection — which the health indicator shares with the cache and
gateway registry — uses `maxRetriesPerRequest: 3` (fail-fast). If
`/health/ready` reports Redis down but other functionality still works, the
underlying Redis is intermittently reachable but slow enough that the
health probe gives up. Investigate network or server health.

### Signed-in requests answer 503

Sessions live in the cache database, so while it is unreachable the api cannot
check one. A request that carries a session answers 503 with a plain-language
message, and `/api/auth/*` answers 503 with the code `AUTH_UNAVAILABLE`,
rather than treating anyone as signed out (#640). Once the cache is reachable
again, sessions work as before, unless Redis lost its data (see above).

### "No provider found for Symbol(CACHE_REDIS_CLIENT)" at startup

The process is trying to use the cache connection but `RedisModule.forRootAsync`
was bootstrapped without a `cache` block. Either add the cache configuration,
or remove the code path that injects `CACHE_REDIS_CLIENT` from this process.
The same applies to `QUEUE_REDIS_CLIENT`.

### "RedisModule.forRootAsync requires at least one of `cache` or `queue`"

The module was imported with an empty options object. Either configure at
least one connection, or remove the `RedisModule` import — processes that
need neither connection should not import the module at all.
