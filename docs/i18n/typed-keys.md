# Compile-time-checked translation keys (#141)

Translation keys are type-checked at compile time. The `en` catalog is the single source of
truth; a generated TypeScript type mirrors its shape so referencing a key that doesn't exist
fails `tsc` (and, in CI, a stale type fails the build).

## Where things live

| Thing                      | Path                                                   |
| -------------------------- | ------------------------------------------------------ |
| Catalogs (source of truth) | `libs/common/i18n/src/lib/i18n/<locale>/*.json`        |
| Generated types            | `libs/common/i18n/src/lib/generated/i18n.generated.ts` |
| Public re-export           | `I18nTranslations`, `I18nPath` from `@bge/i18n`        |

The generated file is **committed**. It carries its own `/* eslint-disable */` / `/* prettier-ignore */`
headers and is excluded from ESLint (`**/i18n.generated.ts` in the root `eslint.config.mjs`). Do not
edit it by hand.

## Regenerating after editing catalogs

After you add, remove, or rename any key in a catalog JSON file:

```bash
npm run i18n:generate
```

Then commit the updated `i18n.generated.ts` alongside your catalog change. Under the hood this runs
the `nestjs-i18n` CLI via the Nx target `@board-games-empire/i18n:generate-types`:

```bash
nestjs-i18n -p libs/common/i18n/src/lib/i18n -o libs/common/i18n/src/lib/generated/i18n.generated.ts
```

CI re-runs the generator and `git diff --exit-code`s the result, so a forgotten regeneration fails
the **Check i18n types are up to date** step with a message telling you to run `npm run i18n:generate`.

## Using the types

Type your i18n call sites against `I18nTranslations` so invalid keys are caught by the compiler:

```ts
import { I18nTranslations } from '@bge/i18n';
import { I18nContext, i18nValidationMessage } from 'nestjs-i18n';

// In a resolver / edge component that reads I18nContext:
const i18n = I18nContext.current<I18nTranslations>();
i18n.t('common.at_least_one_field');

// In a DTO decorator (Phase 2, #142):
@IsNotEmpty({ message: i18nValidationMessage<I18nTranslations>('validation.isNotEmpty') })
name: string;
```

> Type generation is intentionally **not** wired into app bootstrap (`I18nModule.forRoot` uses
> `watch: false` and no `typesOutputPath`). Generation is an explicit, deterministic step — the CLI
> above — so it runs the same way locally and in CI without booting Nest.
