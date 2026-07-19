# Translated exceptions (#143)

Error messages returned to API clients are localized at the edge. Services stay
decoupled from `I18nService` — they throw a normal Nest exception naming a
catalog **key**; a single global filter resolves it against the request's
locale.

## The pattern

```ts
import { t } from '@bge/i18n';
import { NotFoundException } from '@nestjs/common';

throw new NotFoundException(t('errors.language.not_found', { id }));
```

- Use the **standard Nest exception** for the status you want
  (`NotFoundException` → 404, `BadRequestException` → 400, …). The exception
  type still owns the status code.
- Wrap the message in `t(key, args)`. `key` is type-checked against the
  generated catalog types (`I18nPath`) — an unknown key fails `tsc` (see
  [typed-keys.md](./typed-keys.md)).
- `args` fill `{placeholder}`s in the catalog string
  (`"Language with id {id} not found"`).

Do **not** inject `I18nService` into services and translate there. The only
component that touches translation is the filter.

## How it resolves

`t()` returns an `I18nMessage { key, args }`. Nest stores it as the exception's
response body, and `I18nExceptionFilter` (registered globally via `APP_FILTER`
in `apps/api`) recovers it and renders the normal Nest error shape:

```jsonc
{ "statusCode": 404, "message": "<translated>", "error": "Not Found" }
```

Locale comes from `AuditContextService.getLocale()` — the value the entry seam
resolves into CLS **before guards run** — so guard-thrown errors (auth,
throttling) are translated too. `I18nContext.current()` is intentionally not
used: it is unset for exceptions thrown before nestjs-i18n's interceptor. If no
locale is resolved, it degrades to `FALLBACK_LOCALE` (`en`).

Exceptions **without** a `t()` payload pass straight through to Nest's default
handling — nothing about existing error responses changes.

### Controller-scoped filters

The global `I18nExceptionFilter` only runs when no more-specific filter handles
the exception first. A **controller-scoped** filter (`@UseFilters(...)`) that
maps a lower-layer error and renders the response itself (via `super.catch`)
therefore runs *instead of* the global filter — Nest invokes only the most
specific match. Such a filter must resolve markers itself: build the
marker-carrying Nest exception, then hand it to the exported
`translateException(exception, i18n, auditContext)` helper (the same core the
global filter uses) before `super.catch`. Inject `I18nService` and
`AuditContextService` for it — and make sure the controller's **module** can
resolve them. A filter bound by class (`@UseFilters(MyFilter)`) has its
constructor dependencies resolved from the host module's injector, so a missing
one fails at app **bootstrap**, not per-request. `I18nModule` (nestjs-i18n) is
`@Global`, so `I18nService` is always in scope; `AuditContextModule` is **not**
global, so the module must import it explicitly.

```ts
// media StorageExceptionFilter — controller-scoped, so it translates itself
return super.catch(
  translateException(new ServiceUnavailableException(t('errors.storage.unavailable')), this.i18n, this.auditContext),
  host,
);
```

`libs/api/media` does this for its storage/multer filters. Keep such filters
**narrow** (`@Catch(SpecificError)`), never a bare `@Catch()`: a catch-all on a
controller shadows the global exception *and* validation filters for every route
on it, silently bypassing translation.

### Structured bodies (a marker beside machine-readable fields)

Most exceptions carry the `t()` marker *as the whole body*. A few carry
machine-readable fields the client reads programmatically **alongside** the
human message — e.g. `QuotaExceededException` returns `resource`, `scope`,
`limit`, `currentUsage`, `attemptedAmount`, and a custom `error` label next to
its `message`. For these, put the marker only on the `message` field:

```ts
// libs/common/quota QuotaExceededException — structured body, translatable message
super(
  {
    statusCode: Http.PaymentRequired,
    error: 'Quota Exceeded',
    message: t('errors.quota.exceeded', { resource, scope }),
    resource, scope, limit: limit.toString(), /* …currentUsage, attemptedAmount */
  },
  Http.PaymentRequired,
);
```

`translateException` detects a body whose `message` is a marker and translates
**just that field in place**, preserving every sibling field, the custom `error`
label, the status, and the `cause`. (A whole-body marker, by contrast, is
re-issued into Nest's default `{ statusCode, message, error }` shape.) The
`error` field is not a `message`, so the #145 guardrail leaves it alone — it's a
machine-readable label, not localized copy.

### Observability trade-off

Because the message is deferred, `t()` gives the exception an **object** response
body with no string `.message`, so Nest sets `HttpException.message` to the
generic class phrase (e.g. `"Not Found Exception"`). Anything that logs the raw
thrown exception's `.message` before the edge filter runs (a Sentry breadcrumb,
a pino error serializer) therefore records that generic phrase rather than the
old inline string. The **client-facing** response is unaffected — it always
carries the fully translated message. This is inherent to translating at the
edge; if a call site needs a descriptive server-side log line, log it
explicitly at the throw site.

## Adding a new message

1. Add the key to the right catalog file under
   `libs/common/i18n/src/lib/i18n/en/` (e.g. `errors.json`), with
   `{placeholder}`s for any interpolated values.
2. Run `npm run i18n:generate` and commit the regenerated types.
3. Throw with `t('your.new.key', { ...args })`.

## Scope

- **HTTP only.** WebSocket gateways keep their own filters; WS localization is
  tracked in #180.
- This issue (#143) establishes the pattern + filter and converts one exemplar
  site (`language.service.ts`). Converting the remaining ~165 throw sites — and
  collapsing repeated messages into shared `common.*` keys — is Phase 3 (#144);
  see [string-inventory.md](./string-inventory.md) §4 for the shared-key plan.
