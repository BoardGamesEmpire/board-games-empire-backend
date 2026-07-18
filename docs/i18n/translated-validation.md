# Translated validation messages (#142)

Request-validation errors (`class-validator` / DTOs) are localized at the edge,
the same way thrown exceptions are ([translated-exceptions.md](./translated-exceptions.md)).
DTOs stay decoupled from `I18nService` — each decorator names a catalog **key**;
the global pipe + filter resolve it against the request locale.

## The pattern

Point each `class-validator` decorator's `message` at a `validation.*` catalog
key via the `@bge/i18n` facade:

```ts
import { i18nValidationMessage } from '@bge/i18n';
import { IsString, IsBoolean } from 'class-validator';

export class LanguageQueryDto {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name?: string;

  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  systemSupported?: boolean;
}
```

- `i18nValidationMessage` is `@bge/i18n`'s pre-bound wrapper over the
  nestjs-i18n helper — pointed at the generated `I18nTranslations`, so the key
  is type-checked against the `validation.*` catalog (unknown key fails `tsc`,
  see [typed-keys.md](./typed-keys.md)). DTOs import it from `@bge/i18n`, never
  from `nestjs-i18n` directly (mirrors `t()`).
- The key must live under `validation.*` (the wrapper's type enforces it).
- Catalog strings may interpolate `{property}` (the field name), `{value}` (the
  rejected value), and positional constraint args `{constraints.0}`,
  `{constraints.1}`, … (e.g. the `10` in `@MinLength(10)`). Extra named args go
  in the second argument: `i18nValidationMessage('validation.min', { unit: 'kg' })`.

Unannotated decorators keep emitting `class-validator`'s English defaults — the
seeded `validation.*` strings match those defaults verbatim, so annotating a
decorator changes nothing for `en` and only adds a translation seam for other
locales. Annotation is incremental; the full DTO sweep is Phase 3 (#144).

## How it resolves

Two pieces are wired once, in `apps/api`:

1. **`I18nValidationPipe`** replaces the global `ValidationPipe` in
   [`main.ts`](../../apps/api/src/main.ts) (identical options). It is the stock
   pipe with an i18n-aware `exceptionFactory`: on failure it throws an
   `I18nValidationException` carrying the raw markers.
2. **`I18nValidationExceptionFilter`** is registered in
   [`app.module.ts`](../../apps/api/src/app/app.module.ts) via `APP_FILTER`
   with `{ detailedErrors: false }`. It translates the markers against the
   request locale and sends the response.

Locale is resolved the same way as everywhere else: the filter reads the
request's `I18nContext`, whose language comes from the `ClsLocaleResolver` (the
CLS locale the entry seam resolved — see [locale resolution, #140]). The
response body is byte-identical to the pre-i18n `ValidationPipe` contract:

```jsonc
{ "statusCode": 400, "message": ["name must be a string"], "error": "Bad Request" }
```

### Filter ordering (load-bearing)

`I18nValidationException` extends `HttpException`, so the `@Catch(HttpException)`
`I18nExceptionFilter` from #143 would also match it. Nest evaluates global
(`APP_FILTER`) filters in **reverse registration order**, so the validation
filter is declared **after** `I18nExceptionFilter` in the providers array — that
makes it the first match for validation errors, while the catch-all continues to
translate `t()` exceptions and pass everything else through. **Do not reorder
those two providers.** The rule is locked by
[`i18n-validation.filter.spec.ts`](../../libs/common/i18n/src/lib/i18n-validation.filter.spec.ts),
which asserts both a validation error and a `t()` exception render correctly in
one app.

## Adding a new validation message

1. Add the key to `libs/common/i18n/src/lib/i18n/en/validation.json`. Name it
   after the `class-validator` constraint (`isString`, `minLength`, …) so the
   catalog reads as a map of constraint → message.
2. Run `npm run i18n:generate` and commit the regenerated types.
3. Annotate the decorator: `@IsFoo({ message: i18nValidationMessage('validation.isFoo') })`.

## Scope

- **HTTP only.** WebSocket message validation is tracked in #180.
- This issue (#142) installs the machinery + a `validation.*` catalog seed and
  converts one exemplar DTO (`language-query.dto.ts`). Annotating the remaining
  DTO decorators repo-wide is Phase 3 (#144); see
  [string-inventory.md](./string-inventory.md) §1.
