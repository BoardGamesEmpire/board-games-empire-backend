# Gotchas

Traps in this repo that the code doesn't announce. Each one has produced a wrong fix or a false pass before. Check the entry for the area you're touching before you trust a green run or propose a fix.

## WebSockets

- **Global enhancers never run on gateway messages.** `APP_GUARD`, `APP_INTERCEPTOR` and `APP_FILTER` apply to HTTP only; Nest builds the WebSocket context without the global ones. Bind guards, interceptors and filters on the gateway class. `AuthenticatedGateway` (`apps/api/src/app/gateways/base/authenticated.gateway.ts`) authenticates the handshake in namespace middleware, then binds `WsThrottlerGuard`, `WsSessionGuard`, `WsFrameScopeGuard` and `PoliciesGuard`, in that order, plus `WsErrorFilter`; subclasses inherit them. The HTTP `AuthGuard` plays no part. An `APP_*` registration is never a WebSocket fix.

## Auth routes

- **`/api/auth/*` skips every Nest middleware.** better-auth is mounted on the raw Express server in `apps/api/src/main.ts` before Nest registers its middleware, so these requests have no CLS actor, correlation id, locale or ability context. The ordering is deliberate: better-auth needs the raw body. Leave it as it is, and put auth-route behavior in better-auth's own hooks. The one handler ahead of the mount, `createAuthClientIpHandler`, writes the client's IP for better-auth's rate limiter, which runs before every hook and never sees the socket (#640).

## Prisma and permissions

- **A guarded bulk update must not use `limit`.** With `limit`, Prisma moves the `where` into a subquery, and under concurrent writes the guard (`status: Pending`, say) is not rechecked. Read the ids with `findMany({ where: guard, select: { id: true }, take })`, then update with the guard restated alongside `id: { in: ids }`. `settleOutstandingWithin` in `libs/common/invites` is the reference.
- **Deny-all conditions inside `include` / `select` are dropped.** Prisma silently drops an empty `OR: []` nested in `AND`. The CASL extension on `DatabaseService` repairs this for top-level `where` only. A relation filter in `include` / `select`, and any client built without the extension (seeds, data migrations, the e2e test database), still get the unfiltered rows.
- **Catalog conditions use operator form on relations.** Write `{ event: { is: { householdId: '{{ householdId }}' } } }`, not `{ event: { householdId: ... } }`. Prisma accepts the shorthand in a query, but CASL throws when it checks a rule against an object, and `assertCurrentActorCan` turns that into a 403 for everyone. The catalog spec (`findShorthandRelationConditions`) catches the known forms.
- **Paging without `orderBy` is deterministic.** Prisma adds `ORDER BY id` to a top-level `findMany` with `take` / `skip`. Only a presentation order needs an explicit `orderBy`.
- **`@default(now())` is the app's clock.** Prisma stamps it in Node, not in Postgres. Compare it against `Date.now()`, not the database's `now()`.

## Configuration

- **Joi defaults in the root schema win over factory defaults.** `ConfigModule.forRoot({ validationSchema })` writes Joi defaults into `process.env` when the app module is imported, so a factory's `defaultsFor.production` never applies to those keys. Check the process's root schema before stating a setting's default.
- **An empty variable doesn't override `.env`.** dotenv-expand keeps an existing value only when it is non-empty, so `FOO=''` loses to the `.env` file. A test that needs a variable missing or empty launches its child from a directory without `.env`.
- **Nx loads the root `.env` into every task.** Anything an Nx task runs, such as `docker compose`, inherits it, and Compose prefers the shell environment over `--env-file`. Strip the compose files' variables from the environment you pass.
- **Controller-scoped filters resolve dependencies from their host module.** A filter that injects `AuditContextService` needs `AuditContextModule` imported into that module, or the api fails at boot. Unit specs don't catch this.

## Build, lint and test

- **A warm tree can fake a green typecheck.** Leftover `dist` / `out-tsc` output can let a broken change pass locally. Before trusting a "does this break typecheck?" run, delete them: `find libs apps -type d \( -name dist -o -name out-tsc \) -prune -exec rm -rf {} +`.
- **The proto gateway's `build` cache goes stale.** Its generated sources are gitignored, so a `.proto`-only change can restore an old `libs/proto/gateway/dist` (symptom: `UNIMPLEMENTED` or a missing method in a gateway spec or e2e). Delete `libs/proto/gateway/dist` and rerun with `--skip-nx-cache`. A fresh checkout or worktree also needs `npm run nx run @boardgamesempire/proto-gateway:buf-export` before the api boots.
- **Worktrees need `NX_WORKSPACE_ROOT_PATH`.** If the shell exports it pointing at the main checkout, Nx in a worktree runs the main checkout's files. Prefix each Nx command with `NX_WORKSPACE_ROOT_PATH=<absolute worktree path>`.
- **Jest filters by a relative path.** Pass spec paths relative to the repo root (`-- role-permission.catalog`). An absolute path matches nothing and exits 1 with "No tests found".
- **`@OnEvent` listeners never throw into `emit()`.** Nest wraps and logs them. Only raw `emitter.on` / `onAny` listeners can throw, and the two in the repo catch their own errors.
