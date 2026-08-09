# `@boardgamesempire/api-e2e`

Black-box end-to-end suite for the API (#254, #255, #259). The test process never imports application code: `globalSetup` provisions real Postgres and Redis (testcontainers), applies the real migration chain and reference seeds, launches the built bundle (`apps/api/dist/main.js`) as a child process, gates on `/health/ready`, and every assertion travels over HTTP to that server.

## Running locally

```sh
npx nx e2e @boardgamesempire/api-e2e
```

Prerequisites: a running Docker daemon (for testcontainers) and nothing else — the `e2e` target's dependency on `@boardgamesempire/api:build` produces the bundle, and the harness owns provisioning, migration, and seeding end to end.

Note that the api bundle **externalizes its workspace libraries** rather than inlining them (the same reason `apps/api` carries `prune-lockfile` / `copy-workspace-modules` targets for deployment): at runtime `main.js` resolves `@boardgamesempire/*` through the npm-workspace symlinks into each library's `dist/`. `api:build` therefore declares `^build`, without which the bundle starts and then dies on the first workspace import. If you ever see `Cannot find module '.../@boardgamesempire/<lib>/dist/index.js'` during boot, that dependency chain is what broke.

Escape hatches, both optional and both treating the endpoint as **disposable** (migrated, seeded, and swept exactly like a container):

| Variable | Effect |
| --- | --- |
| `BGE_E2E_DATABASE_URL` | Use an existing Postgres instead of a container. |
| `BGE_E2E_REDIS_URL` | Use an existing Redis instead of a container. `resetRedis` (FLUSHALL) additionally requires `BGE_E2E_REDIS_FLUSH_OK=true`. |
| `BGE_E2E_VERBOSE` | Set to `true` to stream the API child's output live instead of buffering it. |

## Isolation model

One database, one Jest worker (`maxWorkers: 1`), truncate sweep between tests (#255). This is deliberate: it is the simplest model that makes cross-test interference structurally impossible, and it stays until the wall-clock budget below says otherwise. The upgrade path — template-database-per-worker parallelism — is #275, and is only warranted if the budget is breached.

## CI

The `e2e` job in `.github/workflows/ci.yml` is defined for every PR to `master` and gated on the unit job via `needs: main` (#259). The job itself always pays checkout and workspace setup; the *suite* runs only when `nx affected` puts `api-e2e` in the affected set, so a change touching neither the api nor its libraries reaches the suite step and no-ops. Notes:

- **Only runs if `main` is green.** Lint, typecheck, and unit failures skip the suite entirely — no containers, no minutes. This also means the affected build the e2e job performs is served from the Nx Cloud cache `main` just populated, rather than recomputed.
- **Verbose by default in CI.** The job sets `BGE_E2E_VERBOSE=true`, so the API's full output lands in the (foldable) job log. On a spec failure, find the failing request's server lines there. If this proves too noisy to diagnose from in practice, #274 (failure-scoped log surfacing) is the filed alternative — say so on that issue rather than suffering quietly.
- **Boot failures**: in buffered (non-verbose) runs the harness replays the child's last 120 output lines. In verbose runs — which CI is — the output has already streamed live, so there is nothing to replay; the failure message says so and the lines are above it in the log.
- The job's `--exclude` list fences off the five scaffolded `*-e2e` apps (#258), **all** of which declare a never-exiting `:serve` task as a target dependency — there is no safe one to unexclude. Remove an exclusion only when #258 implements or deletes that app.
- The container images are pulled anonymously from Docker Hub on every affecting run. If a shared-runner-IP rate limit ever reds the gate, that is a provisioning failure, not a flake — do not quarantine a test for it. First remedy: repoint `POSTGRES_IMAGE` / `REDIS_IMAGE` in `src/support/e2e-env.ts` at a mirror of the official images (e.g. `public.ecr.aws/docker/library/...`); note it on #259 (D-259-6 deferred pull-cost machinery pending real evidence).
- Advisory at first, then flipped to required in branch protection once flake is characterised (D-259-5 on #259).

## Wall-clock budget

| | |
| --- | --- |
| Baseline (first green CI run) | _pending — post to #259 when measured_ |
| Budget | ≈ 2× baseline (record the number here once the baseline exists) |
| Hard stop | `timeout-minutes: 20` on the CI step, 30 on the job |

The budget covers the current single-boot shape. #268's optional worker child adds a second boot for suites that opt in — re-measure and amend this table when it lands, rather than letting the number drift silently.

If the suite outgrows the budget, the levers in rough order of preference: prune or merge slow specs; split into parallel CI jobs; template-database-per-worker (#275). Measure before reaching for the last one.

## Flake policy (D-259-4 on #259)

**No automatic retries — not in Jest, not in the workflow, not ever.** A flaky e2e test against a real database usually indicates a real race, and retry-until-green trains the suite to hide exactly the bugs it exists to find.

When a test flakes (fails on a change that cannot plausibly have caused it, or fails intermittently on re-runs of the same commit):

1. **Quarantine**: change it to `it.skip`, with a comment carrying the issue reference from step 2 and the URL of the failing CI run.
2. **File**: open an issue labelled `bug` describing the failure, linking the run, and referencing #254. The flake is a finding, not an annoyance.
3. **Never** delete the test, wrap it in a retry, or loosen its assertion to make it pass. Un-skip only when the underlying race is understood and fixed.

A red run that was not flake is a regression: the gate did its job. Fix the regression, not the gate.
