# Translated success responses (#144)

The exception path (#143) localizes **error** bodies at the edge. Success
responses that carry user-facing copy — the `message:` field controllers return
on create/update/delete — use the same deferred-marker idea on the success path,
resolved by `I18nResponseInterceptor` instead of a filter.

## The pattern

```ts
import { t } from '@bge/i18n';

map((game) => ({ game, message: t('success.game.created') })),
```

- Controllers return a `t(key, args)` **marker** in the body — never a hardcoded
  string. Services/controllers stay decoupled from `I18nService`, exactly as on
  the error path.
- `I18nResponseInterceptor` (registered once, globally, in `apps/api`) walks the
  response body, replaces every `I18nMessage` marker with its translated string
  for the request locale, and Nest then serializes the plain string.
- Locale comes from `AuditContextService.getLocale()` (the CLS value resolved
  before guards run), degrading to `FALLBACK_LOCALE` (`en`) if no scope is
  active — identical to the exception filter.

The interceptor is the **outermost** global interceptor, so its transform runs
after the response cache. The cache therefore stores locale-independent markers
and this interceptor renders them per request — a cache hit is never pinned to
the locale that first populated it.

Marker-free bodies pass through by reference (no reallocation); the walk is
bounded in depth and descends only plain objects/arrays (never `Date`s or class
instances).

## Swagger stays accurate

A response DTO still types the field as `message: string` (e.g.
`GameMessageResponseDto`). That is correct: the client receives a translated
**string** — the marker only exists in-process, before serialization.

## Adding a new success message

1. Add the key under `success.<lib>.<action>` in
   `libs/common/i18n/src/lib/i18n/en/success.json`.
2. Run `npm run i18n:generate` and commit the regenerated types.
3. Return `t('success.<lib>.<action>', { ...args })` from the controller.

## Catalog conventions (Phase 3)

- **Semantic files, per-entity keys.** `errors.json` → `errors.<entity>.*`,
  `success.json` → `success.<entity>.*`, `validation.json` → `validation.*`,
  shared cross-lib copy → `common.*`.
- **Hybrid dedup.** Collapse a repeated message into a shared `common.*` key
  only when its interpolated values are non-translatable (ids, counts, user
  input). When a message would otherwise interpolate a translatable **noun/verb**
  (`{Entity}`, view/update/delete), use a distinct per-entity / per-action key so
  each is a whole translatable sentence — do not inject an untranslated English
  word into a translated frame.
- **Validation catalog grows per lib.** `validation.json` seeds only the
  class-validator defaults actually annotated so far; add a key (verbatim English
  default) the first time a lib annotates a new decorator.

## Guardrail (#145)

Once a lib is migrated, its `eslint.config.mjs` opts into
`no-restricted-syntax` via `i18nHardcodedStringSelectors` (exported from the root
config), failing the build on any new string/template literal passed to a
`*Exception(...)` or used as a `message:` value. Genuinely non-user-facing cases
use `// eslint-disable-next-line no-restricted-syntax -- <reason>`.
