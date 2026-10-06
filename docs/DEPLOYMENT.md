# Deployment: one image, one role per container

BGE ships as one image that runs any of its four roles, chosen by `BGE_ROLES`, and as one image for each game gateway. This page is the operator's view of them: what each image holds, what each role needs and when it is ready, and the `split` Compose profile that runs them all. Issue #593 carries the decisions. What happens when a role boots, including migrations, is in [BOOTSTRAP.md](BOOTSTRAP.md), and the Redis connections are in [REDIS.md](REDIS.md).

## The images

One `Dockerfile` at the repository root builds all three, from the root:

| Image                 | Build                                                    | Runs                                      |
| --------------------- | -------------------------------------------------------- | ----------------------------------------- |
| BGE                   | `docker build -t bge .`                                  | the role named by `BGE_ROLES`             |
| BoardGameGeek gateway | `docker build --target boardgamegeek-gateway -t <tag> .` | the BoardGameGeek game gateway, over gRPC |
| IGDB gateway          | `docker build --target igdb-gateway -t <tag> .`          | the IGDB game gateway, over gRPC          |

The BGE image is the default target. The game gateways stay out of it: a deployment adds the data sources it wants (#194).

Each image:

- is `node:24-alpine`, pinned by digest, the Node major CI runs. Renovate moves the digest (#599).
- runs as the `node` user (uid and gid 1000), with `NODE_ENV=production` on every channel: an `edge` image is a release channel, not a development build.
- keeps the workspace's layout under `/app`: one production install of every workspace's dependencies, and each bundle at `apps/<app>/dist/main.js`. A bundle runs exactly as it does from a checkout. The three images share that install, so the gateway images are about as large as the BGE image, but pulling all three downloads it once.
- carries the OCI labels `org.opencontainers.image.source`, `.revision`, `.version` and `.created`, from the build arguments `REVISION`, `VERSION` and `CREATED`. They are empty unless passed. Publishing and tags are #600.

Building needs network access to the npm registry, to `binaries.prisma.sh` for Prisma's schema engine (or a `PRISMA_ENGINES_MIRROR`), and to `buf.build` for the gateway protos' dependencies.

The bundles load their npm dependencies at runtime instead of inlining them, so a package the code imports but `package.json` lists under `devDependencies` would be missing from the image. The build checks for that: every package a bundle requires directly must resolve from the production install, or the build fails naming the bundle and the package (`libs/scripts/src/bundle-externals`). What those packages load in turn, and what the code loads by name at runtime, only a boot from the image shows (#600).

## Roles

`BGE_ROLES` names the role a container runs: exactly one, for now. Running several roles in one process is #200. An unset, empty or unknown value, or more than one role, stops the container at once with a message naming the accepted roles.

| Role            | App                        | Listens on                            | Ready when                             | Volumes        |
| --------------- | -------------------------- | ------------------------------------- | -------------------------------------- | -------------- |
| `api`           | `apps/api`                 | HTTP on `SERVER_PORT` (default 33333) | `GET /health/ready` answers 200        | media, plugins |
| `worker`        | `apps/worker`              | nothing                               | no probe: it logs `Bootstrap complete` | media          |
| `gateway-fetch` | `apps/gateway-worker`      | nothing                               | no probe: it logs `Bootstrap complete` |                |
| `coordinator`   | `apps/gateway-coordinator` | gRPC on `COORDINATOR_GRPC_PORT`       | a TCP connection to that port succeeds |                |

The game gateway images listen on gRPC too, each on its `*_GATEWAY_GRPC_PORT`, and are ready on the same TCP check.

What "ready" means here, role by role:

- **The api** answers `/health/ready` once it has booted. That checks Postgres, the api's cache and queue Redis connections, and its storage. `/health/live` answers whenever the server is up. A first boot migrates and seeds before anything listens, so give the api a startup probe that allows minutes ([BOOTSTRAP.md](BOOTSTRAP.md), "First boot takes longer").
- **The coordinator and the gateways** serve no standard gRPC health service (`grpc.health.v1.Health`) yet, so a Kubernetes `grpc` probe fails against them. Probe the port over TCP (`tcpSocket`). The coordinator opens its port once its boot sequence is done; the gateways have no database and open theirs at start.
- **`worker` and `gateway-fetch`** listen on nothing, so there is nothing to probe. Their `Bootstrap complete` log line is the evidence they came up. A role that fails exits, and the restart policy brings it back.

Real health checks for every role are #612.

## Settings

Every role reads its settings from the environment. `.env.example` lists them for development. A container must have these:

| Setting                                                | Roles                 | Notes                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                         | all four roles        | A direct connection, or a pool in session mode: the boot lock is a session lock, and a transaction-mode pooler breaks it ([BOOTSTRAP.md](BOOTSTRAP.md), "The database connection"). Use the database's `public` schema: an empty database cannot yet be migrated into another one. |
| `REDIS_HOST`, `REDIS_BULLMQ_HOST`                      | all four roles        | The cache and queue connections. The api also needs `REDIS_WEBSOCKET_HOST`. Ports, credentials and TLS are in [REDIS.md](REDIS.md).                                                                                                                                                |
| `BETTER_AUTH_SECRET`                                   | `api`                 | Required; the api exits without it.                                                                                                                                                                                                                                                |
| `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`                   | `api`                 | The URL clients reach the api at.                                                                                                                                                                                                                                                  |
| `MEDIA_BASE_URL`                                       | `api`                 | The api's public URL followed by `/api`: the media links it signs point at `<MEDIA_BASE_URL>/media-stream`. The default, `http://localhost:3000`, matches neither the api's port nor its prefix, so leaving it unset breaks every link.                                            |
| `DATA_ENCRYPTION_KEY`                                  | `api`, `worker`       | Required, at least 10 characters, and the same value in both: the worker decrypts what the api encrypted.                                                                                                                                                                          |
| `GATEWAY_COORDINATOR_HOST`, `GATEWAY_COORDINATOR_PORT` | `api`                 | Where the coordinator listens. The host defaults to `localhost`, so set it when the coordinator runs in a container of its own. The port defaults to the coordinator's.                                                                                                            |
| `COORDINATOR_GRPC_HOST`, `COORDINATOR_GRPC_PORT`       | `coordinator`         | Where it listens. The host defaults to `0.0.0.0`, which accepts connections from other containers, and the port to 50051 in production, gRPC's conventional port.                                                                                                                  |
| `*_GATEWAY_GRPC_HOST`, `*_GATEWAY_GRPC_PORT`           | the gateway images    | Where each listens. The host defaults to `0.0.0.0`, and the port to 50051 in production.                                                                                                                                                                                           |
| `BOARDGAMEGEEK_API_KEY`                                | BoardGameGeek gateway | Required.                                                                                                                                                                                                                                                                          |
| `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`                 | IGDB gateway          | Required.                                                                                                                                                                                                                                                                          |

A required setting that is missing or malformed stops the role at boot, and its output names the setting.

## Storage

Two directories hold state that must outlive a container:

- **`/var/lib/bge/media`** is where media is stored (the production default of `MEDIA_LOCAL_DISK_ROOT`). The api and the worker both read and write it, so they need the same volume: `ReadWriteMany` in Kubernetes. The api and the worker refuse to boot when it is missing, rather than write where nobody provisioned storage.
- **`/var/lib/bge/plugins`** holds the plugins the api installs (`PLUGINS_ROOT`).

The image creates both, owned by `node`, so a new named volume mounted on either starts out writable by the role. In Kubernetes, set `fsGroup: 1000` so a mounted volume is too. Without a volume, writes land in the container and are lost with it.

## The split profile

`compose.yaml` runs each role in a container of its own, with Postgres 17, Redis 7 (the versions the e2e suite tests against) and both game gateways:

```sh
docker compose --profile split up --build
```

- **Secrets** come from the shell, or from a `.env` file beside `compose.yaml`, which Compose reads for interpolation only. Set `BETTER_AUTH_SECRET` and `DATA_ENCRYPTION_KEY`, and the gateways' credentials for search. In a development checkout, that `.env` is the development one.
- **The roles start together.** The api migrates and seeds an empty database while the others log that they are waiting, then they boot ([BOOTSTRAP.md](BOOTSTRAP.md)).
- **The api** is on `http://localhost:33333`, published on the host's loopback interface only: the first account to sign up becomes the owner, so a new deployment starts out unreachable from other machines. Once the owner has signed up, `BGE_BIND_ADDRESS` opens it, as `0.0.0.0` for every IPv4 interface or one interface's address. `BGE_PORT` changes the port. `BGE_PUBLIC_URL` sets the URL the api trusts for sign-in and the base of the media links it signs, which defaults to the one above; set it, without a trailing slash, whenever clients reach the api at another URL, including after changing `BGE_PORT`.
- **Postgres and Redis** keep their data in the `postgres` and `redis` volumes, which `docker compose down` leaves in place and `down --volumes` deletes. Redis holds the job queues and the sign-in sessions, so it logs each write and flushes the log every second (append-only persistence), as BullMQ advises.
- **Published images** replace the local builds through `BGE_IMAGE`, `BGE_BOARDGAMEGEEK_GATEWAY_IMAGE` and `BGE_IGDB_GATEWAY_IMAGE`.

Search goes through the coordinator to the gateways registered with the api, and a new deployment has none: it adds the data sources it wants (#194). The first account to sign up becomes the owner. Sign up, then register each gateway once as that account:

```http
POST /api/game-gateways
Content-Type: application/json

{ "name": "BoardGameGeek", "connectionUrl": "boardgamegeek-gateway", "connectionPort": 50053, "authType": "None" }
```

The IGDB gateway is `igdb-gateway` on port 50054.

## Shutdown

On `SIGTERM` each role closes its application, flushes its telemetry, and exits. A role registers those handlers once its boot sequence is done. The role's process is PID 1 in its container, and PID 1 ignores a signal it has no handler for, so a container stopped before then stops only at the kill timeout. The split profile sets `init: true`, which puts an init process in front of the role and lets the signal end it at once. In Kubernetes, the pod's grace period applies.

## Upgrades and rollback

Migrations are forward only. A newer build's api migrates at its boot, and an older build over a newer schema warns and boots without running its seeds ([BOOTSTRAP.md](BOOTSTRAP.md), "Forward only"). Whether an older build is safe over newer data, queued jobs and caches is #597.
