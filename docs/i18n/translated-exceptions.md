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

### Refusals thrown before the locale exists

The entry seam runs as ordered middleware (`AppModule.configure`):
`HttpActorMiddleware` resolves the actor, then `LocaleResolutionMiddleware`
resolves the locale. It has to come second, because the actor's stored language
preference heads its precedence chain. So `HttpActorMiddleware`'s own
refusals throw while CLS holds no locale yet, and they always render in
`FALLBACK_LOCALE`:

- an invalid API key, or one whose owner no longer exists
  (`errors.api_key.invalid`)
- an API key whose owner is banned (`errors.api_key.owner_banned`)
- an impersonated session (`errors.auth.impersonated_session`)

With only `en` shipping, the difference is invisible. The order cannot flip, so
once a second locale ships, the way to localize these is for the edge to
read the request's `Accept-Language` header when CLS holds no locale. Everything
thrown later — guards, pipes, handlers — sees the resolved locale.

### Controller-scoped filters

The global `I18nExceptionFilter` only runs when no more-specific filter handles
the exception first. A **controller-scoped** filter (`@UseFilters(...)`) that
maps a lower-layer error and renders the response itself (via `super.catch`)
therefore runs _instead of_ the global filter — Nest invokes only the most
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
controller shadows the global exception _and_ validation filters for every route
on it, silently bypassing translation.

### Structured bodies (a marker beside machine-readable fields)

Most exceptions carry the `t()` marker _as the whole body_. A few carry
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
    resource,
    scope,
    limit: limit.toString() /* …currentUsage, attemptedAmount */,
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

### Copy that cannot render

A catalog entry whose template string-format rejects makes the translation
throw. `translateException` logs it and sends the marker's key in its place,
so the response keeps its status, and a structured body keeps its other fields
and its `error` label. A throw would escape the filter: over HTTP the client
would get Express's own 500, and a WebSocket frame no answer. The args stay off
the wire, since some carry request input. Every edge that renders a marker
answers this way, as `WsTranslator` does for the copy a gateway sends itself.

### Where no edge translates it

An exception can be thrown where no filter translates it: in a worker, in a
gRPC server, or in code that logs or stores it before the filter runs. There
its `.message` names the marker's key and args (#501), for example
`errors.gateway_registry.auth_type_not_implemented {"authType":"Bearer"}`, or
the key alone when there are no args. A marker's `message` is what Nest copies
into the exception's own, so the stack, a log line and a stored `Job.error` all
say which refusal it was, not just `"Not Implemented Exception"`.

The **client-facing** response is unaffected — it always carries the translated
message. The marker still serializes as its brand, key and args alone: its
`message` lives on the prototype, which `JSON.stringify` and the response
cache's serializer skip.

Two cases still get the class phrase, or no log line at all:

- **A structured body** such as `QuotaExceededException`'s. Nest reads only a
  string `message`, and its `message` is a marker, so `.message` is the class
  phrase (`"Quota Exceeded Exception"`). The two such exceptions,
  `QuotaExceededException` and `TransactionDeadlockError`, are thrown only over
  HTTP, where the filter renders them.
- **A gRPC server** logs no `HttpException`: Nest's default RPC filter answers
  "Internal server error" and skips logging it (#574).

### On WebSocket frames (#180)

No app-wide filter runs on a gateway message, so `I18nExceptionFilter` never
sees one. The gateways' own `WsErrorFilter` renders a thrown marker instead,
through the same `translateException`, and sends it in the WS error envelope. A
structured body keeps its own `error` label and extra fields, as over HTTP.

- **The locale** is resolved once per connection, at the handshake: the user's
  stored preference, then the handshake's `Accept-Language`, then `en`. It is
  stored on `client.data.locale`, and each frame's CLS scope carries it. A
  changed preference therefore applies from the socket's next connection,
  where over HTTP it applies within the preference cache's 60 s.
- **A refused connection** is told why in the handshake's `Accept-Language`
  alone: there is no user yet whose preference could count.
- **What a gateway sends itself**, such as a `search:error` frame, is not
  thrown, so no filter sees it. The gateway renders it with `WsTranslator`,
  from the socket's locale.
- **The framework's own copy stays English**: the 500's "Internal server
  error", which the filter writes on WebSocket and Nest's body says over HTTP
  (#527). A frame whose session has ended is refused with catalog copy,
  `errors.auth.session_invalid` (#511).
- **Over HTTP, a request with no credential** is refused by `ActorAuthGuard`
  (#529). It sends the body better-auth's guard sent, `code: 'UNAUTHORIZED'`
  included, and renders its `message` from `errors.auth.unauthenticated`, whose
  English is still "Unauthorized". It has no WebSocket counterpart: a socket
  without a credential is refused at the handshake.

## Adding a new message

1. Add the key to the right catalog file under
   `libs/common/i18n-core/src/lib/i18n/en/` (e.g. `errors.json`), with
   `{placeholder}`s for any interpolated values.
2. Run `npm run i18n:generate` so your editor sees the new key. The types are
   generated, not committed — every `typecheck` and every app `build`
   produces them on demand.
3. Throw with `t('your.new.key', { ...args })`.

## Scope

- **HTTP and WebSocket** (see above). The gRPC actor interceptors' refusals stay
  English on purpose: Nest answers them with a generic "Internal server error"
  and logs none of them, so nothing reads their text (#574; see
  [string-inventory.md](./string-inventory.md) §5).
- This issue (#143) establishes the pattern + filter and converts one exemplar
  site (`language.service.ts`). Converting the remaining ~165 throw sites — and
  collapsing repeated messages into shared `common.*` keys — is Phase 3 (#144);
  see [string-inventory.md](./string-inventory.md) §4 for the shared-key plan.
