# Boot sequence: migrations, catalog, seeds

Every Postgres-connected process (`api`, `worker`, `gateway-coordinator`, `gateway-worker`) runs a short sequence before its Nest application exists. It is decided from the database, not from configuration: there is no mode flag, no init job, and nothing for an operator to run by hand in production. Issue #236 carries the decisions; this page is the operator's view of them.

## What happens at boot

1. Take the advisory lock `bge:bootstrap` (a Postgres session lock on a dedicated connection). Concurrent boots serialise here; a waiting process logs who holds the lock every few seconds.
2. Read `_prisma_migrations` and compare it with the migration list this build was generated from.
3. Act on what was found:

| The database is…                                      | `api`                                                      | `worker`, `gateway-coordinator`, `gateway-worker`                    |
| ----------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| **in sync**                                           | run the seeds and the catalog reconcile (idempotent), boot | boot                                                                 |
| **behind** (migrations pending)                       | apply them with `prisma migrate deploy`, then as above     | release the lock, wait, re-check; boot once the api has applied them |
| **ahead** (holds migrations this build does not know) | warn, boot; the seeds are left to the newer build          | warn, boot                                                           |
| **failed** (a migration started and never finished)   | refuse to boot                                             | refuse to boot                                                       |

4. Release the lock. The application starts; `/health/ready` becomes reachable.

Only the `api` image carries the Prisma CLI and the migration chain, so only the api can apply. The other three processes cannot be misconfigured into migrating: they have nothing to migrate with. When the whole stack starts at once on an empty database, the api migrates while the others log that they are waiting; they fail their boot only if the schema has not arrived within ten minutes of their start, time spent waiting for the lock included.

The api's database role therefore holds DDL rights, exactly as the `prisma migrate deploy` you would otherwise run by hand requires. Only the schema step needs DDL; the lock, the reconcile and the seeds are ordinary reads and writes. A least-privilege split (a DML-only serving role and a separate migration credential) is #445, post-alpha.

## Forward only

Prisma has no down migrations. A migration that must be undone is undone by a new migration. Rolling back a **build** is fine as long as the newer migration was additive, which forward-only already requires of every migration; the older build logs the unknown migration as a warning and boots. It does not run its seeds over that database: the seeds include the catalog reconcile, and an older manifest would retire the permissions and revoke the grants the newer build added. During a rolling deploy, or after a rollback, the reference data belongs to the build that knows the newer migration.

## First boot takes longer

On an empty database the api applies the whole migration chain and seeds the reference data before it listens. Nothing answers on any port during that time, liveness included. Plan for it:

- **Kubernetes**: give the api a startup probe with a generous `failureThreshold × periodSeconds` (minutes, not seconds) so liveness does not restart the pod mid-migration. Liveness and readiness keep their usual settings; the startup probe gates them.
- **Docker Compose**: set `start_period` on the api's `healthcheck` to cover a first migration, and have the other services `depends_on` the api with `condition: service_healthy` if you would rather they not log waiting lines.

Every later boot is one lock, one query, a few idempotent upserts and a catalog comparison: milliseconds.

If a boot is killed mid-migration, Prisma has applied each completed migration in its own transaction and left the interrupted one marked as started. The next boot refuses with that migration's name and the command to run: inspect the database, then `prisma migrate resolve --rolled-back <name>` (or `--applied` if its statements did complete), and boot again.

## Development

The npm scripts are unchanged and remain the way to work with the schema day to day:

| Script                             | Does                                                            |
| ---------------------------------- | --------------------------------------------------------------- |
| `npm run db:migrate:new -- <name>` | create and apply a migration (`prisma migrate dev`)             |
| `npm run db:migrate`               | apply pending migrations (`prisma migrate deploy`)              |
| `npm run db:seed`                  | run the seeds (`prisma db seed`, the same `runSeeds` boot uses) |
| `npm run db:reset`                 | drop, re-migrate, re-seed                                       |

Applying a migration beside a running server needs no restart: the server compares the database with its build only at boot. After `migrate dev` a build that has not been regenerated sees the database as "ahead" on its next boot: it warns and skips its seeds, which is expected until `db:generate` rewrites the migration manifest (every nx `serve` and `build` of an app does that on the way). `npm run db:seed` seeds from the CLI regardless of what the running build knows.

The three processes without a migrator wait for the schema, not for the seeds. A database migrated by hand (`npm run db:migrate`, a restored dump) but never seeded lets a worker boot before any api has seeded it, and the hooks that read seeded tables find them empty. Run `npm run db:seed` after a hand migration, or start the api first. In production the api's boot migrates and seeds under one hold of the lock, so a waiting process sees the schema only after the seeds have run.

## Where the pieces live

- `@bge/bootstrap` (`libs/common/bootstrap`): the sequence, the lock, the CLI migrator, the `runBootstrap` entry each `main.ts` calls.
- `@bge/database`: the migration manifest (`MIGRATION_NAMES`, generated beside the Prisma client by `nx run database:generate`), the state classifier, `readAppliedMigrations`, and the seeds (`runSeeds`, from `@bge/database/seeds`).
- The api image: `prisma/` and `prisma.config.ts` are copied beside `main.js` and `prisma` is a runtime dependency (`apps/api/webpack.config.js`, `apps/api/package.json`).
