# Board Games Empire — Backend

Board Games Empire (BGE) is a self-hosted platform for managing board game and video game collections, coordinating game nights, and tracking play sessions. It integrates with external data sources (BoardGameGeek, IGDB) to enrich game records automatically, while keeping your data in a database you control.

The backend is a NestJS Nx monorepo exposing a REST + WebSocket API, with game data fetched through a microservice gateway layer that normalizes external platform differences into a shared domain model.

This project is in early development. The API is not stable and may change without warning. Features likely do not fully function
as intended.

---

## Architecture overview

```
apps/
  api/                     — Main NestJS API (REST, WebSocket)
  gateway-coordinator/     — gRPC microservice coordinating gateway fan-out
  igdb-gateway/            — IGDB data adapter (gRPC) - (search and import)
  boardgamegeek-gateway/   — BoardGameGeek data adapter (gRPC) - (WIP)

libs/
  proto/gateway/           — Shared protobuf definitions for gateway communication
  api/*/                   — Feature libraries (game, auth, households, …)
  database/*/              — Prisma schema generation and database access utilities
  common/*/                — Cross-cutting concerns (permissions, utilities, …)
```

The main application, the coordinator and at least one game gateway must be running for the full import and search pipeline to work. The gateways communicate with the coordinator over gRPC; the API communicates with the coordinator over gRPC and exposes results to clients over HTTP and WebSocket.

---

## Prerequisites

- Node.js 22+
- PostgreSQL 16+
- Redis 7+
- [buf CLI](https://buf.build/docs/installation) (for proto generation)
- [foreman](https://github.com/ddollar/foreman) or [nf](https://www.npmjs.com/package/nf) (to run the Procfile)
- IGDB API credentials (Twitch developer account — free)
- BoardGameGeek API key (The application review process will likely take a week or more)

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in at minimum: (one or both gateways)

```
DATABASE_URL=postgresql://user:password@localhost:5432/boardgamesempire
IGDB_CLIENT_ID=your_twitch_client_id
IGDB_CLIENT_SECRET=your_twitch_client_secret
BOARDGAMEGEEK_API_KEY=your_bgg_api_key
```

Most environment variables have sane development defaults.

### 3. Generate the Prisma client, protobuf types, and i18n types

```bash
npm run db:generate
npm run proto:generate
npm run i18n:generate
```

None of the three are committed. Run them once before the first build, and again any time the schema,
the `.proto` files, or an i18n catalog changes.

Two of the three — the Prisma client and the i18n types — are also produced automatically as
task-graph dependencies, since `typecheck` and the app `build`s pull them in. **The protobuf step is
not**: `buf-export` is outside the task graph, and the api build copies `.proto` assets from the
directory it produces, so `npm run proto:generate` genuinely has to be run by hand.

Run all three anyway. It is what gets your editor to resolve `PrismaClient` / `I18nPath` immediately
rather than after the first typecheck, and Nx cannot hash an untracked file, so a task that already
has a cache entry will not re-run just because a generator did.

### 4. Run database migrations and seed

```bash
npm run db:migrate
npm run db:seed
```

The seed populates a number of tables including roles, permissions, system settings and more.

### 5. Start all services

```bash
npm start
```

This runs `nf start`, which launches all processes defined in `Procfile` concurrently:

| Process        | Default port | Description                       |
| -------------- | ------------ | --------------------------------- |
| `api`          | 33333        | Main REST + WebSocket API         |
| `coordinator`  | 50052        | Gateway coordinator (gRPC)        |
| `worker`       |              | Worker service (Queue consumer)   |
| `bgg-gateway`  | 50053        | BoardGameGeek data gateway (gRPC) |
| `igdb-gateway` | 50054        | IGDB data gateway (gRPC)          |

To run a single service in isolation:

```bash
npm start api
npm start worker
npm start coordinator
npm start igdb-gateway
npm start bgg-gateway
```

or several using comma separated values

```bash
npm start api,coordinator,worker
npm start bgg-gateway,igdb-gateway
```

---

## Development workflows

### Running tests

```bash
npm test                          # all projects in parallel
npx nx test api                   # single project
npx nx affected -t test           # only affected projects
```

### End-to-end tests

```bash
npx nx e2e @boardgamesempire/api-e2e
```

The e2e suite is black-box: the built API bundle (`apps/api/dist/main.js`,
produced by the target's `api:build` dependency) runs as its own process
against ephemeral Postgres and Redis containers provisioned by
[testcontainers](https://node.testcontainers.org/), and every behavioral
assertion travels over HTTP (supertest). Docker must be running. Each run
applies the full migration chain from empty and the real reference seeds;
between tests a truncate sweep clears every mutable table while preserving
seeded reference data. The server and containers are stopped on teardown;
if a run crashes before teardown, testcontainers' reaper (ryuk) removes the
containers.

Requirements and knobs:

- **Docker** (or a compatible daemon reachable by testcontainers). CI's
  GitHub-hosted runners have one.
- `.env` must exist (copy `.env.example`) — the harness passes the
  ephemeral `DATABASE_URL` and `REDIS_*`/`REDIS_WEBSOCKET_*`/`REDIS_BULLMQ_*`
  connection variables to the server process and never writes to the file.
- Prisma client, protobuf types, and i18n types must be generated once
  (`npm run db:generate`, `npm run proto:generate`, `npm run i18n:generate`).
  `api:build` pulls the Prisma and i18n generators in itself (#260), so it will
  produce them if they are missing; the protobuf export step is not in the graph
  and still has to be run by hand.
- `BGE_E2E_DATABASE_URL` / `BGE_E2E_REDIS_URL` — escape hatches that skip
  container provisioning and use an existing endpoint instead. **Treated as
  disposable**: migrated, seeded, truncated (and, with
  `BGE_E2E_REDIS_FLUSH_OK=true`, flushed). Never point them at anything you
  care about.
- `BGE_E2E_VERBOSE=true` — streams the server's logs live instead of
  buffering them for failure replay.

### Type checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

### Database

```bash
npm run db:migrate:new <migration-name>   # create and run a new migration
npm run db:seed                           # re-run all seeds (idempotent)
npm run db:reset                          # drop, recreate, migrate, and seed
npm run db:generate                       # regenerate Prisma client after schema changes
```

### Protobuf

```bash
npm run proto:generate    # export .proto files and regenerate TypeScript types
npm run proto:check       # lint and format check
npm run proto:format      # auto-format .proto files
```

---

## External API credentials

[**IGDB**](https://www.igdb.com/) — Register a Twitch application at [dev.twitch.tv](https://dev.twitch.tv/console/apps) to obtain a `client_id` and `client_secret`. IGDB access is granted automatically through the Twitch OAuth client credentials flow; no separate IGDB account is needed.

[**BoardGameGeek**](https://boardgamegeek.com/) — BGG no longer allows open access. API access must be requested after reading the requirements and filling out the application linked on their [API page](https://boardgamegeek.com/using_the_xml_api). The application review process will likely take a week or more.

## Frontend

The frontend clients are being developed (so very slowly) [here](https://github.com/BoardGamesEmpire/board-games-empire-client). They currently have no capabilities
to interact with the backend systems. Use Postman or Insomnia to send test data to endpoints or
[swagger](http://localhost:33333/api) on your local instance.

---

<a href="https://boardgamegeek.com/">
  <img src="apps/boardgamegeek-gateway/src/assets/powered-bgg.webp" width="160" alt="Powered by BGG">
</a>
