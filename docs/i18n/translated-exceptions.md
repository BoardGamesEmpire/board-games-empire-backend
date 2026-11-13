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

## The error envelope (#1260)

Every HTTP error the api answers leaves in one shape, apart from the bodies
better-auth writes itself (below):

```jsonc
{ "statusCode": 409, "error": "Conflict", "message": "<translated>", "code": "CATALOG_ENTRY_CHANGED" }
```

- `statusCode` is the response status.
- `error` is that status's standard reason phrase (`STATUS_CODES[status]`, or
  `"Error"` for a status Node names none for). It is never a custom label.
- `message` is plain-language copy: one string, or a list of strings for a
  validation 400.
- `code` is present exactly when the error names one specific refusal. It is
  SCREAMING_SNAKE (`CATALOG_ENTRY_CHANGED`, `QUOTA_EXCEEDED`), so a client can
  branch on it, or announce its own copy for it, without parsing the message.
  There is no generic per-status code: a plain 404 or an unknown 500 carries
  none. The framework's own refusals carry these (#527, #634):
  - `ROUTE_NOT_FOUND`: a 404 for a request no route matched;
  - `REQUEST_TOO_LARGE`: a 413 for a body over the limit, here and on
    `/api/auth`;
  - `RATE_LIMITED`: a 429 from a throttler tier, over HTTP and WebSocket, and
    from `/api/auth`'s own rate limiter.

  A 404 that a client may read as a statement about a row names the row:
  `COLLECTION_ENTRY_NOT_FOUND` for a collection entry the user can't see
  (missing, already removed, or not theirs, which the 404 never tells apart). A
  404 without such a code, `ROUTE_NOT_FOUND` above all, says nothing about any
  row (#634).

- Any other field (a quota's `limit`, a permission catalog refusal's `problems`) sits
  beside these. No field can override `statusCode`, `error` or `message`.

`errorEnvelope(status, message, fields?)` in `@bge/i18n` builds it. Every
producer goes through it: the global filter and the controller-scoped plugin,
storage and upload filters (via `translateException`), the WebSocket payloads
(via `renderErrorBody`), the last-resort filter for errors that aren't
`HttpException`s, the Host check that answers before Nest sees a request, and
`/api/auth`'s own answers. A failed health check is an envelope too:
Terminus's `error` map gives way to the reason phrase, and `details` still names
every check that failed.

**Bodies that better-auth writes itself**, our own `APIError` throws in the
auth gates among them, keep its `{ code, message }` shape.

### What the framework writes (#527)

Nest, the throttler and body-parser answer some errors themselves, in English
and without `error`. Each is replaced at its source, so it leaves as the
envelope with catalog copy (`errors.request.*`) in the request locale:

- **`UnknownErrorFilter`**, a global `@Catch()` registered so that it is tried
  last, answers everything that isn't an `HttpException`:
  - a body over the limit (body-parser's 413) is `REQUEST_TOO_LARGE`;
  - any other request body-parser can't read keeps its 4xx status, with
    `errors.request.unreadable` and no code. The parser's own text goes to
    the log as a warning;
  - anything else, a bug's `Error`, a 5xx, or another library's error that
    only carries a status (better-auth's `APIError`), is logged and answered
    as a 500 with `errors.request.failed` and no code. An `http-errors` error
    is told apart by its `expose` flag.

  The thrower's own text never reaches the client. It extends
  `I18nExceptionFilter` and answers through it, so the two render alike.

- **`RateLimitGuard`** replaces `ThrottlerGuard` app-wide, and is the base of
  `WsThrottlerGuard`. It throws a `CodedHttpException` 429, `RATE_LIMITED`,
  in place of "ThrottlerException: Too Many Requests". The headers the
  throttler sets, `Retry-After` among them, are unchanged.
- **`I18nExceptionFilter`** answers a 404 for a request no route matched,
  where Nest says `Cannot GET /x`, with `ROUTE_NOT_FOUND` and
  `errors.request.route_not_found`. It reads Express's `req.route`, which is
  set exactly when a route matched, so a 404 a handler throws is never
  stamped. A 404 that already carries a code keeps it, even one a middleware
  throws before routing.

One framework body is still the parser's own: a malformed JSON body's 400
carries the parser's English text, because Nest turns that error into a
`BadRequestException` before any filter sees it (#1261).

### Throwing a coded refusal

A refusal that names a code is thrown as a `CodedHttpException`:

```ts
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

throw new CodedHttpException(Http.Conflict, 'CATALOG_ENTRY_CHANGED', t('errors.permission_catalog.entry_changed'));

// Machine-readable detail goes in `fields`, server-side context in `cause`.
throw new CodedHttpException(
  Http.UnprocessableEntity,
  'CATALOG_ENTRY_REFUSED',
  t('errors.permission_catalog.entry_refused'),
  {
    fields: { problems },
  },
);
```

Its body is already the envelope, with the marker left unrendered until the
edge. Its code wins over a field named `code`, and `ErrorCode`
(`Uppercase<string>`) refuses a lowercase code at compile time. The lint rule
`bge/no-uncoded-exception-body` refuses a `{ code }` body thrown through any
other exception class (`RpcException` aside, whose code is the gRPC status).

A family of refusal classes derives its codes from the class name with
`toErrorCode`: `PluginGrantScopeIdError` → `PLUGIN_GRANT_SCOPE_ID`, and the
deadlock's `TransactionDeadlockError` → `TRANSACTION_DEADLOCK`. The name is a
pinned string, never read from the class, so a rename or minification cannot
change the code.

## How it resolves

`t()` returns an `I18nMessage { key, args }`. Nest stores it as the exception's
response body, and `I18nExceptionFilter` (registered globally via `APP_FILTER`
in `apps/api`) recovers it and renders the error envelope:

```jsonc
{ "statusCode": 404, "error": "Not Found", "message": "<translated>" }
```

Locale comes from `AuditContextService.getLocale()` — the value the entry seam
resolves into CLS **before guards run** — so guard-thrown errors (auth,
throttling) are translated too. `I18nContext.current()` is intentionally not
used: it is unset for exceptions thrown before nestjs-i18n's interceptor. When
CLS holds no locale, the global filters resolve one from the request's
`Accept-Language` header (see below), and that degrades to `FALLBACK_LOCALE`
(`en`).

An exception **without** a `t()` payload gets the envelope too: a string body
(a library's own text) becomes the `message`, and an object body keeps its
fields and gains `statusCode` and `error` (#1260).

### Refusals thrown before the locale exists

The entry seam runs as ordered middleware (`AppModule.configure`):
`HttpActorMiddleware` resolves the actor, then `LocaleResolutionMiddleware`
resolves the locale. It has to come second, because the actor's stored language
preference heads its precedence chain. Some errors are raised while CLS holds no
locale yet:

- `HttpActorMiddleware`'s own refusals: an invalid API key, or one whose owner
  no longer exists (`errors.api_key.invalid`), an API key whose owner is banned
  (`errors.api_key.owner_banned`), an impersonated session
  (`errors.auth.impersonated_session`);
- body-parser's refusals, such as the 413. Its middleware comes from
  `BetterAuthModule`, a global module, and Nest registers a global module's
  middleware ahead of the app's own, so it runs before any CLS scope exists
  (#527).

For these, the global filters (`I18nExceptionFilter`, and `UnknownErrorFilter`
through it) resolve the locale from the request's `Accept-Language` header
alone, with `LocaleResolutionService.resolveAcceptLanguage`, which reads no
database (#508's option A). The stored preference isn't known yet, so it can't
win here. Everything thrown later — guards, pipes, handlers — sees the resolved
locale.

### Controller-scoped filters

The global `I18nExceptionFilter` only runs when no more-specific filter handles
the exception first. A **controller-scoped** filter (`@UseFilters(...)`) that
maps a lower-layer error and renders the response itself (via `super.catch`)
therefore runs _instead of_ the global filter — Nest invokes only the most
specific match. Such a filter must render markers itself: map the error to a
status and a marker, build an `HttpException` from them (a
`CodedHttpException` when it names a code), and hand
`translateException(exception, i18n, auditContext)`'s result, the same one the
global filter sends, to `super.catch`. Inject `I18nService` and
`AuditContextService` for it — and make sure the controller's **module** can
resolve them. A filter bound by class (`@UseFilters(MyFilter)`) has its
constructor dependencies resolved from the host module's injector, so a missing
one fails at app **bootstrap**, not per-request. `I18nModule` (nestjs-i18n) is
`@Global`, so `I18nService` is always in scope; `AuditContextModule` is **not**
global, so the module must import it explicitly.

```ts
// media StorageExceptionFilter — controller-scoped, so it renders itself
const refusal = new HttpException(t('errors.storage.unavailable'), Http.ServiceUnavailable, { cause: exception });

super.catch(translateException(refusal, this.i18n, this.auditContext), host);
```

`libs/api/media` does this for its storage/multer filters. Keep such filters
**narrow** (`@Catch(SpecificError)`), never a bare `@Catch()`: a catch-all on a
controller shadows the global exception _and_ validation filters for every route
on it, silently bypassing translation.

### Structured bodies (a marker beside machine-readable fields)

Most exceptions carry the `t()` marker _as the whole body_. A few carry
machine-readable fields the client reads programmatically **beside** the human
message: `QuotaExceededException` returns `resource`, `scope`, `limit`,
`currentUsage` and `attemptedAmount` next to its `message` and its code. Build
these as a `CodedHttpException` with `fields`:

```ts
// libs/common/quota QuotaExceededException
super(Http.PaymentRequired, 'QUOTA_EXCEEDED', t('errors.quota.exceeded', { resource, scope }), {
  fields: { resource, scope, limit: limit.toString() /* …currentUsage, attemptedAmount */ },
});
```

`renderErrorBody` renders **just the `message`** in the request locale and
keeps every other field, the status and the `cause`. Its `error` is the
status's reason phrase, `"Payment Required"`, like every other error's (#1260).

### Copy that cannot render

A catalog entry whose template string-format rejects makes the translation
throw. `renderErrorBody` logs it and sends the marker's key in its place, so
the response is still a full envelope with its status, and a structured body
keeps its other fields and its code. A throw would escape the filter: over HTTP the client
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

A `CodedHttpException` names its marker the same way, although its body's
`message` is the marker rather than the body itself.

Two cases still get the class phrase, or no log line at all:

- **An object body built by hand** whose `message` is a marker, such as
  `new BadRequestException({ message: t('…') })`. Nest reads only a string
  `message`, so `.message` is the class phrase (`"Bad Request Exception"`).
  Throw a whole-body marker or a `CodedHttpException` instead.
- **A gRPC server** logs no `HttpException`: Nest's default RPC filter answers
  "Internal server error" and skips logging it (#574).

### On WebSocket frames (#180)

No app-wide filter runs on a gateway message, so `I18nExceptionFilter` never
sees one. The gateways' own `WsErrorFilter` renders a thrown marker instead,
through the same `renderErrorBody` behind `translateException`, and sends it in
the WS error envelope:
the HTTP envelope plus the frame's `pattern` and `correlationId`. A structured
body keeps its extra fields, its code among them, under the status's reason
phrase, as over HTTP.

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
- **The framework's own copy is catalog copy**, as over HTTP (#527): an
  unexpected error's 500, on a frame and at the handshake, says
  `errors.request.failed`, and a frame over its throttle limit gets the
  `RATE_LIMITED` 429. A frame whose session has ended is refused with catalog
  copy, `errors.auth.session_invalid` (#511).
- **Over HTTP, a request with no credential** is refused by `ActorAuthGuard`
  (#529). It keeps the code better-auth's guard sent, `UNAUTHORIZED`, in the
  error envelope, and renders its `message` from `errors.auth.unauthenticated`,
  whose English is still "Unauthorized". It has no WebSocket counterpart: a
  socket without a credential is refused at the handshake.

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
