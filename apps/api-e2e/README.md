# `@boardgamesempire/api-e2e`

Black-box end-to-end suite for the API (#254, #255, #259). The test process never imports application code: `globalSetup` provisions real Postgres and Redis (testcontainers), applies the real migration chain and reference seeds, launches the built bundle (`apps/api/dist/main.js`) as a child process, gates on `/health/ready`, and every assertion travels over HTTP to that server.

## Running locally

```sh
npx nx e2e @boardgamesempire/api-e2e
```

Prerequisites: a running Docker daemon (for testcontainers) and nothing else — the `e2e` target's dependencies on `@boardgamesempire/api:build` and `@boardgamesempire/worker:build` produce the bundles, and the harness owns provisioning, migration, and seeding end to end.

Note that the api bundle **externalizes its workspace libraries** rather than inlining them (the same reason the production image ships those libraries' `dist/` beside its install; see the root `Dockerfile`): at runtime `main.js` resolves `@boardgamesempire/*` through the npm-workspace symlinks into each library's `dist/`. `api:build` therefore declares `^build`, without which the bundle starts and then dies on the first workspace import. If you ever see `Cannot find module '.../@boardgamesempire/<lib>/dist/index.js'` during boot, that dependency chain is what broke.

Escape hatches, both optional and both treating the endpoint as **disposable** (migrated, seeded, and swept exactly like a container):

| Variable               | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BGE_E2E_DATABASE_URL` | Use an existing Postgres instead of a container. The database role must be a superuser, on PostgreSQL 13 or later: the bootstrap spec creates and drops sibling databases in the same cluster (`bge_bootstrap_e2e`, `bge_migration_credential_e2e`, `bge_pooler_e2e`), and two database roles of its own, one of which owns a database it creates. It also starts a PgBouncer container, which reaches this database at `BGE_E2E_DATABASE_CONTAINER_ADDRESS`: set that to the `host:port` a container reaches it at, or those tests fail naming it. |
| `BGE_E2E_REDIS_URL`    | Use an existing Redis instead of a container. Unless `BGE_E2E_REDIS_FLUSH_OK=true` also marks it disposable, the rate-limit sweep at setup is skipped, and `isolateQueue` and `useWorker` refuse to run: the feedback specs and any worker suite fail, naming that variable.                                                                                                                                                                                                                                                                        |
| `BGE_E2E_VERBOSE`      | Set to `true` to stream the API and worker children's output live instead of buffering it.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Isolation model

One database, one Jest worker (`maxWorkers: 1`), truncate sweep between tests (#255). This is deliberate: it is the simplest model that makes cross-test interference structurally impossible. CI gets its speed by splitting the spec files across parallel jobs instead (see [CI](#ci)), each a runner with its own containers, API child and single worker, so the model holds within each.

## Queues and the worker child

The baseline is **no consumer**: the API registers producers only, so a job a spec causes sits in `waiting`, where the spec can assert on it. Two opt-in helpers in `src/support/` change that for one spec file (#268):

- **`isolateQueue(name)`** obliterates the queue before and after each test, and holds it empty when the file finishes. A file that fills a queue needs this even if it never looks at the queue. For the feedback queue that is enforced: every file runs `checkLeftoverJobs`, which fails a file that finishes with more jobs pending there than it started with.
- **`useWorker()`** runs the built worker (`apps/worker/dist/main.js`) beside the API for that file, and returns its queues. Call `markQueueEvents` before the request and `drainQueue` after it. The drain reads the queue's events stream, so it throws on a failed delivery or a retry instead of waiting out the backoff. Don't also `isolateQueue` a queue the worker consumes, because its per-test obliterate would remove jobs the worker is holding.

A worker boot, from spawn to a consumer on every queue, took just under a second locally (two runs, 2026-09-28). Every file that installs `useWorker()` pays it. The worker's output follows the API child's contract: buffered and replayed if it dies during boot, or streamed live with `BGE_E2E_VERBOSE=true`.

## CI

The `e2e` job in `.github/workflows/ci.yml` runs for every PR to `master` and every push to it (#259), beside the unit job rather than after it, and split into shards: parallel jobs, each with its own runner, containers and API child, that divide the spec files between them with Jest's `--shard` (#684). The job's matrix sets the count, two today. Each always pays checkout and workspace setup; the _suite_ runs only when `nx affected` puts `api-e2e` in the affected set, so a change touching neither the api nor its libraries reaches the suite step and no-ops. Notes:

- **Doesn't wait for `main`.** A lint, typecheck or unit failure doesn't skip the suite. Each shard builds the affected graph itself, uncached, on its own critical path.
- **Off Nx Cloud.** Connected, the shards would join `main`'s CI pipeline execution, where Nx Cloud's self-healing acts on any failure, and an e2e failure isn't one to hand it (#259). So the job sets `NX_NO_CLOUD`, which is also why its builds are never cache hits. The job's comment in `ci.yml` says why `.nx/ci-config.yaml` isn't used instead.
- **Shards split by file count, not duration.** Jest assigns each spec file to a shard by a hash of its path. To run one shard's files locally: `npx nx e2e @boardgamesempire/api-e2e --shard=1/2`.
- **Verbose by default in CI.** The job sets `BGE_E2E_VERBOSE=true`, so the API's full output lands in the (foldable) job log. On a spec failure, find the failing request's server lines there. If this proves too noisy to diagnose from in practice, #274 (failure-scoped log surfacing) is the filed alternative — say so on that issue rather than suffering quietly.
- **Boot failures**: in buffered (non-verbose) runs the harness replays the child's last 120 output lines. In verbose runs — which CI is — the output has already streamed live, so there is nothing to replay; the failure message says so and the lines are above it in the log.
- **The gateway e2e apps run whole, in the first shard.** Jest fails a run that finds no tests, so a project can't be split more ways than it has spec files. Each gateway app has two, enough for two shards but not for three, so the suite step excludes them by name and a step of their own runs them. Both steps choose projects by exclusion (`nx affected` has no `--projects`), so a new e2e app runs in both until it joins one list.
- The container images are pulled anonymously from Docker Hub by each shard, on every affecting run. If a shared-runner-IP rate limit ever reds the gate, that is a provisioning failure, not a flake — do not quarantine a test for it. First remedy: repoint `POSTGRES_IMAGE` / `REDIS_IMAGE` in `src/support/e2e-env.ts` at a mirror of the official images (e.g. `public.ecr.aws/docker/library/...`). #683 tracks a lasting fix for these pulls.
- **Advisory for now.** Making it required in branch protection, once its flake is characterised (#259), means requiring a summary job with `needs: e2e`, or every shard's check by name: a matrix reports one check per shard.

## Wall-clock budget

|           |                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline  | **2m44s** for the `e2e` job — 2026-08-10, [PR #287's run](https://github.com/BoardGamesEmpire/board-games-empire-backend/actions/runs/31378763014) |
| Budget    | **≈ 5m30s** for the `e2e` job (2× baseline)                                                                                                        |
| Hard stop | `timeout-minutes: 20` on the suite step, 30 on the job                                                                                             |

The baseline is the whole job, so it includes checkout, `setup-workspace`, and `nx affected -t build`; the suite step itself is some fraction of it. Two things make it a deliberately conservative figure rather than a best case: the Nx Cloud cache was warm, and because that PR touched `ci.yml` (which is in `sharedGlobals`) every project was affected, making the build step as wide as it ever gets.

The budget covers the current single-boot shape and a suite that is still only the harness, actor fixtures, and support specs. Real domain coverage (#257) is what will move it. The worker child adds one boot for each file that opts in (see [Queues and the worker child](#queues-and-the-worker-child)). Re-measuring this table against the suite as it now stands is #301.

The suite is already split across parallel CI jobs. If a shard's job outgrows the budget (#301 re-measures it per shard), the levers in rough order of preference: prune or merge slow specs; balance the shards by duration rather than file count; add a shard, which costs every run another runner's setup, uncached build and Docker Hub pulls (#683). Measure first.

## Flake policy (D-259-4 on #259)

**No automatic retries — not in Jest, not in the workflow, not ever.** A flaky e2e test against a real database usually indicates a real race, and retry-until-green trains the suite to hide exactly the bugs it exists to find.

When a test flakes (fails on a change that cannot plausibly have caused it, or fails intermittently on re-runs of the same commit):

1. **Quarantine**: change it to `it.skip`, with a comment carrying the issue reference from step 2 and the URL of the failing CI run.
2. **File**: open an issue labelled `bug` describing the failure, linking the run, and referencing #254. The flake is a finding, not an annoyance.
3. **Never** delete the test, wrap it in a retry, or loosen its assertion to make it pass. Un-skip only when the underlying race is understood and fixed.

A red run that was not flake is a regression: the gate did its job. Fix the regression, not the gate.
