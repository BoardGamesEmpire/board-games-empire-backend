# Compile-time-checked translation keys (#141)

Translation keys are type-checked at compile time. The `en` catalog is the single source of
truth; a generated TypeScript type mirrors its shape so referencing a key that doesn't exist
fails `tsc`.

## Where things live

| Thing                      | Path                                                        |
| -------------------------- | ----------------------------------------------------------- |
| Catalogs (source of truth) | `libs/common/i18n-core/src/lib/i18n/<locale>/*.json`        |
| Generated types            | `libs/common/i18n-core/src/lib/generated/i18n.generated.ts` |
| Public re-export           | `I18nTranslations`, `I18nPath` from `@bge/i18n`             |

`@bge/i18n-core` holds the catalogs, the types generated from them, and the two markers — `t()` for
exceptions and `i18nValidationMessage` for decorators — and loads nothing at runtime beyond
`node:path`. It writes the validation marker in nestjs-i18n's format itself, rather than calling
nestjs-i18n; a spec in `@bge/i18n` pins it byte for byte to the vendor's encoder, with array
constraints joined first (#503). `@bge/i18n` re-exports the markers and the key types beside the
edge machinery that does the translating.

**Import from `@bge/i18n`.** Apart from `@bge/i18n` itself, a lib imports `@bge/i18n-core` directly
only when importing `@bge/i18n` would do one of two things:

- **Form a cycle.** `@bge/actor-context`, which the edge filters read the locale from, is a
  dependency of `@bge/i18n`, so importing `@bge/i18n` there would form a circular project reference
  that `tsc --build` rejects (#189).
- **Load the runtime into processes that emit no localized text.** `@bge/shared`'s pagination DTOs
  mark their messages, and the IGDB and BGG gateways load `@bge/shared` at boot (through
  `@bge/gateway-host` and `@bge/utils`). Importing `@bge/i18n` there would carry nestjs-i18n and
  `@bge/database` into both gateways (#503).

No lint rule enforces this.

The generated file is **not committed** — it is gitignored (`**/generated/*`) and produced on
demand, the same as the Prisma client and the protobuf output (#260). It carries its own
`/* eslint-disable */` / `/* prettier-ignore */` headers and is excluded from ESLint
(`**/i18n.generated.ts` in the root `eslint.config.mjs`). Do not edit it by hand.

## Regenerating after editing catalogs

Usually you don't. The Nx target that produces it is a dependency of `typecheck` (via the
`^generate` default in `nx.json`) and of every app's `build`, so editing a catalog and typechecking
picks up the new keys with no explicit generate step:

```bash
nx run-many -t typecheck
```

To refresh it directly — most useful for getting your editor to see new keys without waiting for a
full typecheck:

```bash
npm run i18n:generate
```

Under the hood that runs the `nestjs-i18n` CLI via the Nx target
`@board-games-empire/i18n-core:generate`:

```bash
nestjs-i18n -p libs/common/i18n-core/src/lib/i18n -o libs/common/i18n-core/src/lib/generated/i18n.generated.ts
```

A project that declares its own `typecheck.dependsOn` **replaces** the `nx.json` default rather than
merging with it, and loses `^generate` unless it lists it. What counts is the project-reference
closure, not direct imports: `tsc --build` compiles every referenced project. `@bge/database`
reaches `@bge/i18n-core` through `@bge/otel` → `@bge/actor-context`, so it declares the union
`["generate", "^generate"]`. `@boardgamesempire/proto-gateway` references nothing and keeps
`["generate"]`; the first reference it gains that leads to `@bge/i18n-core` fails its typecheck on a
cold clone until its `dependsOn` gets the union too (#312).

`test` pulls it in through the same `^generate` default, but no test needs it: Jest transpiles
through `@swc/jest`, which erases these type-only imports.

## Known hazard: a cached typecheck can outlive a catalog change

**Nx cannot hash a gitignored file.** The generated types are excluded from Nx's file map, so they are
not an input to any `typecheck`, and the catalog JSONs are not inputs either. A change that edits
only a catalog therefore leaves every `typecheck` hash unchanged: the generator re-runs and rewrites
the type, and `typecheck` serves a cache hit against the old one.

Measured on this workspace: deleting `errors.household.last_owner` from `en/errors.json` and running
`nx typecheck @board-games-empire/household` regenerates the type without the key and reports
success, while the same command with `--skip-nx-cache` fails with `TS2345` on the now-invalid `t()`
call. The failure mode is a PR that deletes or renames a key without touching its call sites.

Nothing else catches it either. The app builds do not type-check — `tsPlugins` is not wired to
ts-loader's `transformers` option, so it runs `transpileOnly`, and a deliberate type error in
`apps/api/src/main.ts` builds clean. Jest erases the type-only imports through `@swc/jest`.

**CI covers this**: `ci.yml` detects when a PR touches `libs/common/i18n-core/src/lib/i18n/` and runs
`typecheck` with `--skip-nx-cache` for that run. That is strictly stronger than the byte-comparison
drift gate it replaced, since it compiles the workspace against the regenerated type.

**Locally you are on your own.** A cached `typecheck` after a catalog edit proves nothing. Run
`nx run-many -t typecheck --skip-nx-cache` if you have deleted or renamed a key.

### Accepted, not fixed

The local gap is knowingly left open: CI catches it before anything merges, so the cost is a
confusing local green rather than a broken master. If that starts wasting real time — someone chasing
a passing typecheck that CI then rejects — the fix is to stop relying on the cache for these targets,
not to start committing the artifact.

Worth knowing that this is a **class** of problem, not an i18n one. Any generated source that is
gitignored is invisible to Nx's file map and so cannot be an input to the tasks that consume it. The
Prisma client has the identical shape; it is just far less likely to bite, because a schema change
normally arrives alongside a migration and application code, and those move the hashes anyway. A
catalog edit is unusual in being able to change the meaning of existing code all by itself. On a fresh clone the file does not exist until
something generates it, which means your editor will report unresolved `I18nPath` /
`I18nTranslations` imports until you run one of the commands above — the same first-clone
experience the Prisma client and protobuf types already have.

## Using the types

Type your i18n call sites against `I18nTranslations` so invalid keys are caught by the compiler:

```ts
import { I18nTranslations, i18nValidationMessage } from '@bge/i18n';
import { I18nContext } from 'nestjs-i18n';

// In a resolver / edge component that reads I18nContext:
const i18n = I18nContext.current<I18nTranslations>();
i18n.t('common.at_least_one_field');

// In a DTO decorator (Phase 2, #142); the key is checked against validation.*:
@IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
name: string;
```

> Type generation is intentionally **not** wired into app bootstrap (`I18nModule.forRoot` uses
> `watch: false` and no `typesOutputPath`). Generation is an explicit, deterministic step — the CLI
> above — so it runs the same way locally and in CI without booting Nest.
