# Nx caching — deliberate exceptions

> Why a couple of targets are configured against the Nx defaults. Config files
> are strict JSON and carry no comments, so the reasoning lives here.

## `@bge/database:generate` is uncached

`libs/database/project.json` sets `"cache": false` on the `generate` target
(`prisma generate`). This is deliberate.

Nx's capture of the generated client directory is **lossy in this workspace**.
`prisma generate` writes 136 files into `libs/database/src/lib/generated`, but
restoring a cache hit produced only a subset — 108, 117, or 71 files depending
on the hash — silently dropping whole models, `Account` and `Session` among
them.

The resulting client is not merely incomplete, it is broken at the root:

```ts
// libs/database/src/lib/generated/client.ts
export const PrismaClient = $Class.getPrismaClientClass();
```

With the tree partially restored, `PrismaClient` resolves to `undefined`, and
every consumer fails on:

```
TypeError: Class extends value undefined is not a constructor or null
  at DatabaseService extends PrismaClient
```

That surfaces in two places at once — `tsc` reports
`Module './client' has no exported member 'Prisma'`, and at runtime
`prisma db seed` dies before it can connect.

Declaring `outputs` as a recursive glob instead of the bare directory does
**not** fix it. That was measured: 136 files written, 117 restored. The lossy
capture is not a glob-shape problem.

Regenerating costs roughly 500ms, which is far cheaper than the failure mode.

### Why this hid for so long

The task's hash covers `prisma/**/*.prisma` and `prisma.config.ts`, so it only
re-keys when the schema changes — which is rare. Whether a given hash held a
complete or a partial artifact was luck. `master` stayed green because its hash
happened to hold a good one; a schema-comment-only change (#316) moved the hash
onto a bad one and broke four typechecks plus the e2e seed. Had that merged, it
would have taken `master` with it.

`externalDependencies: ["prisma", "@prisma/client"]` was added to the same
target's `inputs` at that time. That is a separate fix: the Prisma version was
absent from the hash, so upgrading Prisma did not invalidate consumers.

## `test` depends on `^generate`

`nx.json` sets `"dependsOn": ["^build", "^generate"]` on the `test` target
default, mirroring the `^generate` that `typecheck` declares.

This is load-bearing **because** `generate` is uncached. The task now genuinely
rewrites the generated directory in place rather than restoring it atomically,
so a project whose tests import `@bge/database` can read the tree mid-write. It
manifested as `@board-games-empire/i18n:test` failing with:

```
Cannot find module './internal/prismaNamespace.js'
  from '../../database/src/lib/generated/client.ts'
```

while every other suite passed. `^generate` makes consumers wait, which is what
the dependency actually is.

## `generate` runs through a lock, not `prisma generate` directly

The target's command is `node libs/scripts/src/bin/prisma-generate.js`. That wrapper exists
because uncaching the target removed the thing that was accidentally serialising
it.

`npm start` is `nf start`, and the Procfile launches one `nx run
<app>:serve:development` per app — six separate Nx processes with six separate
task graphs. Nx dedupes a task within one invocation, never across invocations,
so every one of them runs `@bge/database:generate` for itself. While the target
was cached, five of those were restores. Uncached, they are six real
`prisma generate` runs starting within milliseconds of each other, all deleting
and rewriting the same output directory:

```
ENOTEMPTY: directory not empty, rmdir '.../generated/models'
EEXIST: file already exists, mkdir '.../generated/models'
.../generated exists and is not empty but doesn't look like a generated Prisma Client
```

Whichever error surfaces first fails that app's whole serve chain, and a
half-written tree is left on disk for the next run to trip over.

The wrapper does two things, and both are needed:

- **An exclusive lock** (`node_modules/.cache/prisma-generate/lock.json`) so only
  one run writes at a time. A free lock is taken with `link`, which fails if the
  lock already exists and creates a file that already carries its owner record —
  so a kill mid-acquire cannot strand a lock nobody can identify. A lock is stale
  when its owner died, when it outlived any plausible run, or when it has carried
  no readable owner for a couple of seconds. Freeing a stale lock and taking it
  are **separate** steps: the reclaimer renames the lock aside, which is exclusive
  (two waiters cannot both move it, the loser gets `ENOENT`), and then competes
  for the now-free lock through the ordinary `link` like anyone else. Replacing
  the lock in place instead would let two reclaimers each read back their own
  record and both conclude they hold it. The staleness threshold is deliberately
  shorter than the wait timeout: a waiter that gave up first could never reclaim
  anything, which is the defect #338 was filed for.
- **A fingerprint** over `prisma/**/*.prisma`, `prisma.config.ts`, and the
  installed `prisma` / `@prisma/client` versions, recorded in
  `node_modules/.cache/prisma-generate/stamp.json` with the file count of the
  tree it produced. A run whose fingerprint and file count already match does
  nothing.

The lock alone would be a regression dressed as a fix: six serialised runs still
rewrite the client five more times than necessary, while other apps' webpack
builds are reading it — the same mid-write read described in the previous
section. The fingerprint is what makes those five no-ops. The file count is the
integrity half of it, so a tree that was partially deleted is regenerated rather
than trusted.

To confirm it still holds, from a cold tree:

```bash
rm -rf libs/database/src/lib/generated node_modules/.cache/prisma-generate
for i in 1 2 3 4 5 6; do node libs/scripts/src/bin/prisma-generate.js & done; wait
find libs/database/src/lib/generated -type f | wc -l   # expect 136
```

Exactly one run should report `Generated Prisma Client`; the other five should
report `client is up to date, skipping`.

## If you revisit this

The honest summary is that Nx's directory-output caching is not trustworthy for
the Prisma client here. Before re-enabling it, reproduce the capture directly:

```bash
NX_NO_CLOUD=true npx nx reset
rm -rf libs/database/src/lib/generated
NX_NO_CLOUD=true npx nx run database:generate     # executes; count the files
find libs/database/src/lib/generated -type f | wc -l   # expect 136

rm -rf libs/database/src/lib/generated
NX_NO_CLOUD=true npx nx run database:generate     # restores from cache
find libs/database/src/lib/generated -type f | wc -l   # must also be 136
```

If the second count is lower, the capture is still lossy and caching must stay
off.

## `i18n-core:typecheck` names its inputs

`libs/common/i18n-core/package.json` gives the `typecheck` target an explicit
`inputs` list: the list the `@nx/js/typescript` plugin infers, unchanged, plus
`{projectRoot}/src/lib/i18n/**/*.json`.

The task emits the declarations every other project compiles against,
`dist/lib/generated/i18n.generated.d.ts` among them. The generated source is
gitignored, so it is absent from Nx's file map, and the inferred inputs cover
only the lib's TypeScript. Without the catalogs as inputs, a catalog change left
the task's hash unchanged. CI's catalog guard, since removed (#330), ran that
change's typecheck with `--skip-nx-cache`, which writes nothing, so the entry
cached before the change stayed current.
Every later run whose own diff missed the catalogs restored declarations without
the change: #615 failed on a key #605 had added (#619).

The list repeats the inferred one because, in Nx 22.7.3, an explicit `inputs`
replaces the inferred list rather than extending it, and a `"..."` entry is kept
as a literal rather than spread. After an `@nx/js` upgrade, re-derive it: remove
the `inputs` key, read the inferred list from
`nx show project @board-games-empire/i18n-core --json`, and add the catalog glob
back.

To check that the input works, run the target twice, so that the second run is a
cache hit. Then change a catalog and run it again: it should execute rather than
restore.

## `typecheck` depends on `^typecheck`

`nx.json` sets `"dependsOn": ["^typecheck", "^generate"]` on the `typecheck`
target default. The `@nx/js/typescript` plugin infers `["^typecheck"]`, and a
`targetDefaults` entry replaces the inferred value rather than merging with it,
so the default has to name it again.

The task is `tsc --build`, which brings every referenced project up to date
before checking its own. Without `^typecheck`, a project and its dependencies
start at the same time, and two `tsc --build` processes write the same
`dist/*.d.ts` files. A process that reads a half-written file fails with
`TS2306: File '.../dist/....d.ts' is not a module` or `TS6305`, and passes on a
re-run (#330).

The projects that declare their own `typecheck.dependsOn` (`apps/api`,
`@bge/database`, `i18n-core`, `proto-gateway`) replace the default too, so each
of them lists `^typecheck` as well. A new override must keep it.

`^typecheck` is also what re-keys a project when a dependency's declarations
change. The inferred inputs hash dependencies' `.d.ts` files through
`dependentTasksOutputFiles`, which follows only the tasks in `dependsOn`. Drop
`^typecheck` from an override and that project keeps its hash when a dependency
changes, and a cached run restores a verdict made against the old declarations.

That is why CI no longer bypasses the cache when the i18n catalogs change. The
catalogs are inputs of `i18n-core:typecheck`, so a catalog change re-keys it and,
through its declarations, every project that compiles against it. A re-keyed
task on CI finds no `dist`, since the workflow deletes it before running, so it
compiles from scratch. Locally, a leftover `dist` can let `tsc --build` pass a
project it should fail, so delete `dist` before trusting a local run after a
catalog edit (`docs/i18n/typed-keys.md` has the measurement).

## Generated sources are typecheck inputs

`@bge/database` and `proto-gateway` give the `typecheck` target an explicit
`inputs` list: the list the plugin infers, unchanged, plus
`{"dependentTasksOutputFiles": "**/*.ts"}`. That entry hashes the TypeScript the
project's own `generate` task wrote: the Prisma client and
`migrations-manifest.ts` in `libs/database/src/lib/generated`, and the
`buf generate` output in `libs/proto/gateway/src/gen`.

Both directories are gitignored, so they are absent from Nx's file map, and the
inferred inputs never see them change. Without the entry, a schema change, a
new migration or a `.proto` edit kept the task's hash, and every run restored
the declarations cached before it. On CI that failed every cached typecheck
after #278 added fields, on code the failing PRs never touched; only runs that
skipped the cache passed (#330).

Hashing the output rather than naming what `generate` reads means the list
cannot fall behind the generator: a new schema file, a migration, a Prisma or
`buf` upgrade and a generator script change are all covered by what they write.
It works because `generate` is in the task's `dependsOn`, and its output is
deterministic, so an unchanged tree keeps the cache.

Projects that depend on these two need nothing extra, as long as their
`typecheck` keeps `^typecheck` (see above): they hash the declarations this
task emits.

Re-derive the list after an `@nx/js` upgrade, as for `i18n-core`: remove the
`inputs` key, read the inferred list from `nx show project <name> --json`, and
add the `dependentTasksOutputFiles` entry back. To check that it works, run the
target twice so that the second run is a cache hit, then add a migration
directory with a `migration.sql` (for `@bge/database`) or a message to a `.proto` file and run it
again: it should execute rather than restore.
