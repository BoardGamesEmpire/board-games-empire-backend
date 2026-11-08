# Deployment: one image, one role per container

BGE ships as one image that runs any of its four roles, chosen by `BGE_ROLES`, and as one image for each DataGateway. This page is the operator's view of them: what each image holds, what each role needs and when it is ready, and the `split` Compose profile that runs them all. Issue #593 carries the decisions. What happens when a role boots, including migrations, is in [BOOTSTRAP.md](BOOTSTRAP.md), and the Redis connections are in [REDIS.md](REDIS.md).

## The images

One `Dockerfile` at the repository root builds all three, from the root:

| Image                 | Build                                                    | Runs                                     |
| --------------------- | -------------------------------------------------------- | ---------------------------------------- |
| BGE                   | `docker build -t bge .`                                  | the role named by `BGE_ROLES`            |
| BoardGameGeek gateway | `docker build --target boardgamegeek-gateway -t <tag> .` | the BoardGameGeek DataGateway, over gRPC |
| IGDB gateway          | `docker build --target igdb-gateway -t <tag> .`          | the IGDB DataGateway, over gRPC          |

The BGE image is the default target. The DataGateways stay out of it: a deployment adds the ones it wants (#194).

Each image:

- is `node:24-alpine`, pinned by digest, the Node major CI runs. Renovate moves the digest (#599).
- runs as the `node` user (uid and gid 1000), with `NODE_ENV=production` on every channel: an `edge` image is a release channel, not a development build.
- keeps the workspace's layout under `/app`: one production install of every workspace's dependencies, and each bundle at `apps/<app>/dist/main.js`. A bundle runs exactly as it does from a checkout. The three images share that install, so the gateway images are about as large as the BGE image, but pulling all three downloads it once.
- carries the OCI labels `org.opencontainers.image.source`, `.revision`, `.version` and `.created`, from the build arguments `REVISION`, `VERSION` and `CREATED`. They are empty unless passed; CI passes all three (see [Published images](#published-images)).

Building needs network access:

- to the npm registry;
- to `binaries.prisma.sh` for Prisma's schema engine, or to a `PRISMA_ENGINES_MIRROR`;
- to `buf.build` for the gateway protos' dependencies;
- to `ghcr.io` for the web client's image, which is public.

The bundles load their npm dependencies at runtime instead of inlining them, so a package the code imports but `package.json` lists under `devDependencies` would be missing from the image. The build checks for that: every package a bundle requires directly must resolve from the production install, or the build fails naming the bundle and the package (`libs/scripts/src/bundle-externals`). What those packages load in turn, and what the code loads by name at runtime, only a boot from the image shows: CI's image smoke suite boots every role from the images, on every pull request and before every publish (#600).

## The web client

The BGE image carries the web client's build (#598). It is copied from the client's own image, `ghcr.io/boardgamesempire/bge-client-web`, to `apps/api/dist/web`, beside the api's bundle. The `Dockerfile` pins that image by digest in `CLIENT_WEB_IMAGE`, and the BGE image records the reference in its `io.github.boardgamesempire.web.image` label, so every image names the client it carries. The DataGateway images don't carry it.

The api serves the client from its own origin. A browser pointed at the api's URL (`BGE_PUBLIC_URL` in the split profile) loads the app, and the app's sign-in cookies work without a proxy in front.

- **The server's paths stay the server's:** `/api` and everything under it, and likewise `/socket.io`, `/health`, `/metrics` and `/.well-known`. Socket.IO answers under `/socket.io/` before any of the api's routes see it.
- **Paths in the build** are served from it.
- **Paths the build lacks:** a browser loading a page gets the app's `index.html`, and the app routes from there. Everything else gets a 404, so a missing script or asset is never answered with a page.
- **Caching:** every file is sent with `Cache-Control: no-cache` and an ETag taken from its content. Flutter names its files the same in every release, so browsers ask about each file on every load, and the api answers 304 for any file the new build didn't change.
- **Content-Security-Policy:** the client's files carry their own policy. It is helmet's default, which the API's own responses keep, with these changes:
  - `'wasm-unsafe-eval'`, because the client compiles WebAssembly;
  - `https:` in `connect-src`, for game images, and for the fonts Flutter fetches from `fonts.gstatic.com` when the text has glyphs its bundled fonts lack, such as emoji or Chinese and Japanese characters;
  - `blob:` and `https:` in `img-src`, for game images. Their URLs point at whatever host the DataGateway reported or a user gave, so until the api serves its own copies (#652), users' browsers load them straight from that host, which sees their IP address (#996);
  - no `upgrade-insecure-requests`, so a deployment on plain HTTP works.

When `apps/api/dist/web` has no `index.html`, the api serves only the API. It logs which case it is at boot. Working on the client locally needs no bundled client: the client repository's dev proxy gives the browser one origin (`docs/dev/web-proxy.md` there).

## Published images

CI publishes the three images to GitHub's container registry from each commit on `master` that passes every check (#600):

| Image                 | Package                                              |
| --------------------- | ---------------------------------------------------- |
| BGE                   | `ghcr.io/boardgamesempire/bge`                       |
| BoardGameGeek gateway | `ghcr.io/boardgamesempire/bge-boardgamegeek-gateway` |
| IGDB gateway          | `ghcr.io/boardgamesempire/bge-igdb-gateway`          |

- **Tags:**
  - `edge` follows `master`: each publish moves it forward to its commit, and never back. The three packages' `edge` move in the same run, the BGE image's first. A run that fails partway leaves the rest where they were until it is re-run or a newer commit publishes, so for images that were tested together, pull one `sha-<short>`.
  - `sha-<short>`, the first seven characters of a commit, names that commit's images and never moves.
  - Version tags come with releases (#601).
- **Platforms:** each tag holds a `linux/amd64` and a `linux/arm64` image, and a pull takes the host's. Each was tested on a runner of its own platform, and a tag lists exactly the images that passed.
- **Labels:** `org.opencontainers.image.revision` names the commit, `.version` the version the build stamps, and `.created` the commit's date.

GHCR creates a package private. Once an org owner has made these public, after their first publish, pulling them needs no credentials.

## Roles

`BGE_ROLES` names the role a container runs: exactly one, for now. Running several roles in one process is #200. An unset, empty or unknown value, or more than one role, stops the container at once with a message naming the accepted roles.

| Role            | App                        | Listens on                      | Ready when                             | Volumes        |
| --------------- | -------------------------- | ------------------------------- | -------------------------------------- | -------------- |
| `api`           | `apps/api`                 | HTTP on `PORT` (default 33333)  | `GET /health/ready` answers 200        | media, plugins |
| `worker`        | `apps/worker`              | nothing                         | no probe: it logs `Bootstrap complete` | media          |
| `gateway-fetch` | `apps/gateway-worker`      | nothing                         | no probe: it logs `Bootstrap complete` |                |
| `coordinator`   | `apps/gateway-coordinator` | gRPC on `COORDINATOR_GRPC_PORT` | a TCP connection to that port succeeds |                |

The DataGateway images listen on gRPC too, each on its `*_GATEWAY_GRPC_PORT`, and are ready on the same TCP check.

What "ready" means here, role by role:

- **The api** answers `/health/ready` once it has booted. That checks Postgres, the api's cache and queue Redis connections, and its storage. `/health/live` answers whenever the server is up. A first boot migrates and seeds before anything listens, so give the api a startup probe that allows minutes ([BOOTSTRAP.md](BOOTSTRAP.md), "First boot takes longer").
- **The coordinator and the DataGateways** serve no standard gRPC health service (`grpc.health.v1.Health`) yet, so a Kubernetes `grpc` probe fails against them. Probe the port over TCP (`tcpSocket`). The coordinator opens its port once its bootstrap is done; the DataGateways have no database and open theirs at start.
- **`worker` and `gateway-fetch`** listen on nothing, so there is nothing to probe. Their `Bootstrap complete` log line is the evidence they came up. A role that fails exits, and the restart policy brings it back.

Real health checks for every role are #612.

## Settings

Every role reads its settings from the environment. `.env.example` lists them for development. A container must have these:

| Setting                                                | Roles                 | Notes                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                         | all four roles        | A direct connection, or a connection pooler in session or transaction pooling, not statement pooling; its number of server connections and its idle-transaction timeouts matter ([BOOTSTRAP.md](BOOTSTRAP.md), "The database connection"). Use the database's `public` schema: an empty database cannot yet be migrated into another one. |
| `DATABASE_MIGRATION_URL`                               | `api`                 | The migration credential. The migrations connect with it, everything else with `DATABASE_URL`, whose database role then needs no DDL rights. A direct connection or session pooling. Optional, unless `DATABASE_URL` goes through transaction pooling. Grants: [BOOTSTRAP.md](BOOTSTRAP.md), "The migration credential".                  |
| `REDIS_HOST`, `REDIS_BULLMQ_HOST`                      | all four roles        | The cache and queue connections. The api also needs `REDIS_WEBSOCKET_HOST`. Ports, credentials and TLS are in [REDIS.md](REDIS.md).                                                                                                                                                                                                       |
| `BETTER_AUTH_SECRET`                                   | `api`                 | Required; the api exits without it.                                                                                                                                                                                                                                                                                                       |
| `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`                   | `api`                 | The URL clients reach the api at. `BETTER_AUTH_URL` is required: the api exits without it. These and `MEDIA_BASE_URL` also name the addresses the api answers at; see [Behind a reverse proxy](#behind-a-reverse-proxy).                                                                                                                  |
| `OIDC_PROVIDERS`, `OIDC_<ID>_*`                        | `api`                 | Optional. The sign-in providers; see [Sign-in providers](#sign-in-providers) below.                                                                                                                                                                                                                                                       |
| `MEDIA_BASE_URL`                                       | `api`                 | The api's public URL followed by `/api`: the media links it signs point at `<MEDIA_BASE_URL>/media-stream`. The default, `http://localhost:33333/api`, is a development api's, so leaving it unset breaks every link clients follow from elsewhere.                                                                                       |
| `DATA_ENCRYPTION_KEY`                                  | `api`, `worker`       | Required, at least 10 characters, and the same value in both: the worker decrypts what the api encrypted.                                                                                                                                                                                                                                 |
| `GATEWAY_COORDINATOR_HOST`, `GATEWAY_COORDINATOR_PORT` | `api`                 | Where the coordinator listens. The host defaults to `localhost`, so set it when the coordinator runs in a container of its own. The port defaults to the coordinator's.                                                                                                                                                                   |
| `COORDINATOR_GRPC_HOST`, `COORDINATOR_GRPC_PORT`       | `coordinator`         | Where it listens. The host defaults to `0.0.0.0`, which accepts connections from other containers, and the port to 50051 in production, gRPC's conventional port.                                                                                                                                                                         |
| `*_GATEWAY_GRPC_HOST`, `*_GATEWAY_GRPC_PORT`           | the gateway images    | Where each listens. The host defaults to `0.0.0.0`, and the port to 50051 in production.                                                                                                                                                                                                                                                  |
| `BOARDGAMEGEEK_API_KEY`                                | BoardGameGeek gateway | Required.                                                                                                                                                                                                                                                                                                                                 |
| `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`                 | IGDB gateway          | Required.                                                                                                                                                                                                                                                                                                                                 |

A required setting that is missing or malformed stops the role at boot, and its output names the setting. Every malformed one is named at once, except the sign-in provider settings below, which the api checks only after the others pass.

### Sign-in providers

The `api` can let registered users sign in through identity servers you choose, such as Authentik, Keycloak or Google. None is on by default (#912).

- `OIDC_PROVIDERS` lists the providers' ids, separated by commas. An id holds lowercase letters, digits and hyphens only. It becomes part of the redirect address, and the rule keeps every id's variable names distinct. An empty entry (a trailing comma), a duplicate or any other character stops the api, and the output names each one.
- Each listed id needs four variables, named after the id in upper case with hyphens turned into underscores. For `google-work`: `OIDC_GOOGLE_WORK_DISCOVERY_URL`, `OIDC_GOOGLE_WORK_CLIENT_ID`, `OIDC_GOOGLE_WORK_CLIENT_SECRET` and `OIDC_GOOGLE_WORK_DISPLAY_NAME`. All four are required, and the discovery URL must be an `http` or `https` URL. A missing variable or a malformed discovery URL stops the api and is named, together with any bad id.
- A first sign-in creates a user only when the provider confirms the email address (`email_verified`). Otherwise it is refused with `error=SIGN_IN_PROVIDER_EMAIL_UNVERIFIED`, because a provider that lets people enrol under any address would let someone register an address here before its owner. The api reads the claim from the provider's ID token and from its UserInfo endpoint, so either can confirm the address, but only if it names that same address. A UserInfo answer about a different user than the ID token's refuses the sign-in with `error=unable_to_get_user_info`. `OIDC_<ID>_ALLOW_UNVERIFIED_EMAIL=true` lets that provider through anyway, for one that never sends the claim and that you trust to check addresses. Its users start with their email unverified. The same setting lets a signed-in user link that provider even though it doesn't confirm the email address; any other provider is linked only if it does. The variable is optional; anything but `true` or `false` stops the api and is named.
- A variable of that shape whose id is not listed is ignored and logged as a warning at startup, which catches a typo in an id.
- The client secret can come from a variable of its own, such as a Kubernetes `secretKeyRef`, like any other setting.
- `compose.yaml` passes the api only the variables it names, so put the `OIDC_*` variables under the api service in a `compose.override.yaml`.
- In the provider's own settings, register `<BETTER_AUTH_URL>/api/auth/callback/<id>` as the redirect URI.
- Native apps sign in through the same providers with nothing more to register: the browser still returns to `<BETTER_AUTH_URL>/api/auth/callback/<id>`, and the api hands the app a session of its own. Only the official app's return address, `bge://oauth`, is accepted (#1019); allowing third-party apps is #1048.
- The provider linking policy decides what happens when a provider sign-in carries the email address of a registered user who hasn't linked that provider (#913). Server admins set it in the server's system settings (`providerLinkingPolicy`), and a change applies to the next sign-in, with no restart.
  - Under `SignedIn`, the default, the sign-in is refused with `error=account_not_linked`. The user signs in another way, then links the provider from their sign-in methods.
  - Under `AutomaticWhenVerified`, the sign-in links the provider to that user when the provider confirms the email address and the user's email address is verified here. Today that's the first registered user (the Owner) and users created through a provider that confirms email addresses. Anyone else needs email verification (#439) first; until then the sign-in is refused with `error=account_not_linked`.
  - A provider with `OIDC_<ID>_ALLOW_UNVERIFIED_EMAIL=true` links itself this way only when it does send `email_verified: true`.
  - With `AutomaticWhenVerified`, anyone who controls a registered user's verified email address at one of your sign-in providers can sign in as that user. That includes the Owner, and users who have turned on two-factor sign-in, since a sign-in through a provider doesn't ask for a two-factor code. Choose it only if you trust every provider you list to check the addresses its users hold.
- A signed-in user can link a provider only from a session signed in within the last day (#913). A link started from an older session is refused with 403 and `PROVIDER_LINK_NEEDS_RECENT_SIGN_IN`. The user signs in again, with any sign-in method, then links the provider.
- When the api starts, it asks each provider for its discovery document, one provider at a time. A provider that refuses the connection is skipped, and the api asks it again on the next request that names it, so it recovers with no restart; until then, signing in through it answers that the provider was not found. A provider that accepts the connection and never answers is worse: for about five minutes per such provider, it holds up every request to `/api/auth`, every other request that carries a session or an API key, and every WebSocket connection that carries a session (#1023). Any other request isn't held, so a health check with no credential stays green meanwhile. Swagger is on by default only in development (`SWAGGER_ENABLED`); with it on, the api builds its API document before it starts listening, and that waits for the same hold, so the api doesn't listen until the hold ends.

## Outgoing mail

The server sends email through an SMTP server you choose: password reset links, and a server admin's test email (#654). The mail settings live in the server settings, not in the environment, so there is no variable to set. A server admin sets them with `PATCH /api/system-settings/:id`.

- **Nothing is sent until a server admin sets an SMTP host and a From address.** Until then, password resets are refused with `MAIL_NOT_CONFIGURED`, and discovery (`/.well-known/bge-identity`) reports `password_reset_available: false`. A change to the mail settings applies to the next email, with no restart.
- **Connection security** is one of three modes. `StartTls`, the default, connects in plain text and then upgrades to TLS, usually on port 587; a server that can't upgrade is refused. `ImplicitTls` uses TLS from the first byte, usually on port 465. `None` uses no TLS at all, for a relay on the same machine or a network you trust. With `None`, the SMTP user and password cross the network unencrypted, so anyone who can watch that network can read them.
- **The worker sends the mail**, connecting straight to the SMTP host. That connection doesn't go through the outbound HTTP policy, so a relay on `localhost` or a private address works. Whether it should go through the policy is being decided with sign-in providers' requests (#982).
- **The SMTP password is encrypted** with `DATA_ENCRYPTION_KEY` before it is stored, and no read returns it: the settings show only `smtpPasswordSet`. If you change `DATA_ENCRYPTION_KEY`, the stored password can no longer be read. Mail then stops with `MAIL_SETTINGS_UNREADABLE` until a server admin enters the password again.
- **A reset link works for `passwordResetLinkLifetimeMinutes`**: 1440 minutes (24 hours) by default, at least 15 and at most 10080 (a week). The email tells the user how long they have, and a link works only once.
- **To check the settings**, a server admin sends a test email with `POST /api/system-settings/mail-test`. It goes to the server admin's own address, and a notification then says whether it was sent or why not.

## Behind a reverse proxy

The api answers only at its own names: the hosts in `BETTER_AUTH_URL`, `TRUSTED_ORIGINS` and `MEDIA_BASE_URL`, plus `localhost` and any IP address. Any other `Host` gets a 421 with the code `HOST_NOT_ALLOWED` (#977). A Socket.IO handshake is refused in Socket.IO's own way, a 403 on polling and a 400 on a websocket, with the code in the message. This stops a malicious page from reaching the server through DNS rebinding, where the page points its own domain at your server's address so that the visitor's browser treats the two as one site.

Only the hostname is compared, ignoring case, so ports don't matter. `TRUSTED_ORIGINS` entries work as they do for sign-in, with `*` and `?` as wildcards, and an entry can also be a bare name such as `scrape.example`. A `TRUSTED_ORIGINS` entry whose hostname is only wildcards, such as `*` or `*.*`, turns this check off, and the api warns about it at boot. A wildcard under a domain where anyone can register a name, such as `*.duckdns.org`, gets no warning but lets those names reach the api too, so list your own name instead.

**What the proxy must do:** forward the client's `Host` unchanged. The api ignores `X-Forwarded-Host`, because a web page can set that header on its own requests.

**Internal callers:** Compose healthchecks and Kubernetes probes that use an IP address keep working. A scraper that targets a service name, such as `api:33333`, adds that name to `TRUSTED_ORIGINS` or targets an IP address.

**Under Compose:** `TRUSTED_ORIGINS` defaults to `BGE_PUBLIC_URL`. To add a name, set `TRUSTED_ORIGINS` in your `.env`. The api still answers at `BGE_PUBLIC_URL` and trusts it for sign-in, so that value needn't be repeated.

**Status of the notes below:** they come from each project's documentation. None of these setups has been run against this check, so they are likely to work but untested.

- **Traefik** keeps `Host` by default (`passHostHeader: true`), so don't turn that off.
- **Caddy** keeps `Host` when proxying over HTTP. Since 2.11 it rewrites `Host` when the upstream is HTTPS, so there add `header_up Host {hostport}`.
- **nginx** sends the upstream's name by default (`Host $proxy_host`), which the api refuses. Add `proxy_set_header Host $host;`.
- **Authentik** changes nothing as a sign-in provider, or as forward auth behind one of the proxies above. Its proxy provider sends the configured upstream as `Host`, so prefer forward auth. Otherwise add the upstream name to `TRUSTED_ORIGINS`, which leaves rejecting unknown names to the outpost.
- **Authelia** sits beside the proxy and never between the proxy and the api, so only the proxy's rule above applies. Its own nginx `proxy.conf` already sets `Host $host`. As a sign-in provider it changes nothing.
- **Keycloak** is a sign-in provider only: the browser goes to Keycloak and returns to `BETTER_AUTH_URL`, so it changes nothing here. Its own `--proxy-headers` and `--hostname` settings concern its own proxy, not this check.

## Storage

Two directories hold state that must outlive a container:

- **`/var/lib/bge/media`** is where media is stored (the production default of `MEDIA_LOCAL_DISK_ROOT`, which staging has no default for). The api and the worker both read and write it, so they need the same volume: `ReadWriteMany` in Kubernetes. The api and the worker refuse to boot when it is missing, rather than write where nobody provisioned storage.
- **`/var/lib/bge/plugins`** holds the plugins the api installs (`PLUGINS_ROOT`).

The image creates both, owned by `node`, so a new named volume mounted on either starts out writable by the role. In Kubernetes, set `fsGroup: 1000` so a mounted volume is too. Without a volume, writes land in the container and are lost with it.

## The split profile

`compose.yaml` runs each role in a container of its own, with Postgres 17, Redis 7 (the versions the e2e suite tests against) and both DataGateways:

```sh
docker compose --profile split up --build
```

- **Secrets** come from the shell, or from a `.env` file beside `compose.yaml`, which Compose reads for interpolation only. Set `BETTER_AUTH_SECRET` and `DATA_ENCRYPTION_KEY`, and the DataGateways' credentials for search. In a development checkout, that `.env` is the development one.
- **The roles start together.** The api migrates and seeds an empty database while the others log that they are waiting, then they boot ([BOOTSTRAP.md](BOOTSTRAP.md)).
- **The api** is on `http://localhost:33333`, and so is the web client: open that address in a browser. It is published on the host's loopback interface only: the first account to sign up becomes the owner, so a new deployment starts out unreachable from other machines. Once the owner has signed up, `BGE_BIND_ADDRESS` opens it, as `0.0.0.0` for every IPv4 interface or one interface's address. `BGE_PORT` changes the port. `BGE_PUBLIC_URL` sets the URL the api trusts for sign-in and the base of the media links it signs, which defaults to the one above; set it, without a trailing slash, whenever clients reach the api at another URL, including after changing `BGE_PORT`.
- **Postgres and Redis** keep their data in the `postgres` and `redis` volumes, which `docker compose down` leaves in place and `down --volumes` deletes. Redis holds the job queues and the sign-in sessions, so it logs each write and flushes the log every second (append-only persistence), as BullMQ advises. It has no memory limit, and if you give it one, keep the eviction policy `noeviction`: the job queues share it, and BullMQ needs it. What bounds the cache is each entry's TTL: the one its write sets, or else `CACHE_TTL` milliseconds in the api (five minutes unless set).
- **Published images** replace the local builds through `BGE_IMAGE`, `BGE_BOARDGAMEGEEK_GATEWAY_IMAGE` and `BGE_IGDB_GATEWAY_IMAGE`, such as `ghcr.io/boardgamesempire/bge:edge` (see [Published images](#published-images)). Fetch them with `docker compose --profile split pull`, then start them with `up` and no `--build`, which would build the checkout under their names instead.

Search goes through the coordinator to the DataGateways registered with the api, and a new deployment has none: it adds the ones it wants (#194). The first account to sign up becomes the owner. Sign up, then register each DataGateway once as that account:

```http
POST /api/data-gateways
Content-Type: application/json

{ "name": "BoardGameGeek", "connectionUrl": "boardgamegeek-gateway", "connectionPort": 50053, "authType": "None" }
```

The IGDB gateway is `igdb-gateway` on port 50054.

## Shutdown

On `SIGTERM` each role closes its application, flushes its telemetry, and exits. A role registers those handlers once its bootstrap is done. The role's process is PID 1 in its container, and PID 1 ignores a signal it has no handler for, so a container stopped before then stops only at the kill timeout. The split profile sets `init: true`, which puts an init process in front of the role and lets the signal end it at once. In Kubernetes, the pod's grace period applies.

## Upgrades and rollback

Migrations are forward only. A newer build's api migrates at its boot, and an older build over a newer schema warns and boots without running its seeds ([BOOTSTRAP.md](BOOTSTRAP.md), "Forward only"). Whether an older build is safe over newer data, queued jobs and caches is #597.
