# @bge/scripts

Build-path scripts that run under bare `node`, plus the modules behind them.

Nothing imports this library. Its entrypoints are invoked by path from Nx targets:

| Entrypoint                        | Invoked by                       |
| --------------------------------- | -------------------------------- |
| `src/bin/prisma-generate.js`      | `@bge/database:generate`         |
| `src/bin/generate-bge-version.js` | `@boardgamesempire/api:generate` |

Because the call sites are command strings rather than imports, Nx cannot infer
the dependency. Each consuming target declares these files in its own `inputs`.

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

`src/bgg` and `src/igdb` are **not** part of this library; those ad-hoc scripts
still live in the top-level `scripts/` directory and are covered by no target
(#345).
