# @bge/scripts

Build-path and CI scripts that run under bare `node`, plus the modules behind them.

Nothing imports this library. Its entrypoints are invoked by path, from Nx targets, from CI or from the image build:

| Entrypoint                          | Invoked by                                                       |
| ----------------------------------- | ---------------------------------------------------------------- |
| `src/bin/prisma-generate.js`        | `@bge/database:generate`                                         |
| `src/bin/generate-bge-version.js`   | `@boardgamesempire/api:generate`                                 |
| `src/bin/check-spec-swcrc.js`       | the "Check spec swcrc source maps" step in `ci.yml`'s `main` job |
| `src/bin/check-bundle-externals.js` | the root `Dockerfile`, after its production-only install         |

Because the call sites are command strings rather than imports, Nx cannot infer
the dependency. Each consuming target declares these files in its own `inputs`.
The CI step needs no inputs, because it runs uncached. The image build mounts
`src/` from its build context, so Docker's own layer cache tracks the file.

## Why it is unbuilt

There is deliberately **no `tsconfig`** here, so the `@nx/js/typescript` plugin
infers neither `typecheck` nor `build`. The entrypoints sit ahead of
`@bge/database:generate`, which the whole workspace waits on through `^generate`;
compiling them would put a build step in front of that, once per Nx process, and
six of those run under `npm start`. The sources are plain CommonJS `.js` for the
same reason — they run before anything has been built.

`jest.config.cts` matches the repo convention; the sources it tests are JS.

## What is tested

`src/prisma-generate/lock.spec.js` covers the lock's acquire, reclaim, and
release paths. The clock, process liveness, and the poll wait are injected, so
the reclaim races are driven deterministically rather than chased with signals —
see the header of `src/prisma-generate/lock.js` for which guarantees hold and
which window is knowingly left open (#338).

`src/spec-swcrc/check.spec.js` runs the `.spec.swcrc` check against throwaway
git repositories. It covers the values that pass and fail, a file that isn't
JSON, finding no files at all, and which files count: tracked, or untracked and
not ignored, with a conflicted file listed once. It also covers which repository
gets checked: a root below the top is refused, and git hook variables pointing
elsewhere are ignored. The header of `src/spec-swcrc/check.js` explains why
coverage needs `"inline"` (#524).

`src/bundle-externals/check.spec.js` runs the bundle-externals check against
throwaway directories laid out like the image. It covers externals that resolve
and one that does not, a subpath through a package's `exports`, a package
installed under one app's own `node_modules` (found for that app only), text
that mentions `require` without being an external, and a bundle with no
externals it can read, which it reports instead of passing. The header of
`src/bundle-externals/check.js` explains why the image needs it (#593).

`src/eslint-rules/no-nested-ceiling.spec.js` tests a rule that lives in the
root `eslint.config.mjs`, not in this library. Every project's lint target
already hashes the root config, so keeping the rule there means an edit to it
re-lints the whole tree. A file here would be an input of no lint target. For
the same reason, this project's `test` target lists the root config among its
inputs, in `package.json`. The rule flags a permission ceiling under an
`include`, a `select` or a nested write's `data`, or in a variable named for
one, where it fails open (#559). The spec covers each ceiling call it knows,
each of those keys and names, nesting, and the shapes it leaves alone: a scoped
read that is itself the value of one of those keys, a `compose()` that isn't
the scope composer's, a variable named for something else, and the rule's
known gap, a ceiling that reaches the include through a variable or a call.

`src/bgg` and `src/igdb` are **not** part of this library; those ad-hoc scripts
still live in the top-level `scripts/` directory and are covered by no target
(#345).
