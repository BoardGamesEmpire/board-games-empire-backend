# i18n String-Surface Inventory (#136)

Phase 0 deliverable for the i18n epic (#135). Tagged inventory of every server-generated,
human-readable string, classified in-scope vs out-of-scope, grouped by lib to parallelize the
Phase 3 migration (#144).

**Method:** repo-wide sweep of `libs/` and `apps/` (excluding `*.spec.ts`, `node_modules`, `dist`,
`out-tsc`) for `throw new *Exception(...)`, class-validator messages, custom `ValidatorConstraint`
`defaultMessage()`, and controller response `message:` fields. `Logger.*` output is excluded (logs
stay English).

## Confirmed scope (per epic)

- **In:** API exception/error messages, validation messages, and server-generated human-readable
  strings (incl. controller success `message:` bodies and the import client-safe copy map).
- **Out:** notification bodies (rendered client-side from `type + payload`), domain content
  (game descriptions etc. — own `languageId` relations), and all custom/domain **error classes**
  (operator/developer-facing — see §5).

---

## 1. Headline findings

1. **Validation localization requires per-decorator annotation (CORRECTED 2026-07-16).** Across 46
   DTO/validator files there is exactly **one** inline custom `message:` and **three** custom
   `ValidatorConstraint.defaultMessage()` strings. An earlier draft of this doc claimed
   `I18nValidationPipe` overrides class-validator's built-in default messages **centrally** — that is
   **wrong** (confirmed against nestjs-i18n v10.8.4 docs). `I18nValidationPipe` only translates
   messages emitted via the `i18nValidationMessage<I18nTranslations>('validation.KEY')` marker on
   **each decorator**; unannotated decorators keep emitting English defaults. So localizing validation
   IS a per-DTO grind — annotating decorators across all ~46 files, plus a `validation.*` catalog
   namespace. That annotation sweep is **Phase 3 work (#144)**; Phase 2 (#142) only installs the
   machinery (swap the pipe, register `I18nValidationExceptionFilter`, seed the `validation.*` catalog,
   document the convention). No custom `exceptionFactory` exists anywhere.
2. **New category: controller success messages.** ~42 hardcoded English `message:` strings returned
   in success response bodies (e.g. `Game created successfully`). Not in the original exception count;
   in scope.
3. **~165 HTTP-exception throw sites**, but 19 live in `actor-context-transport` auth plumbing
   (17 on internal service-to-service gRPC channels). Treat those as a **separate low-priority
   bucket** — low end-user value.
4. **Heavy duplication → far fewer keys than sites.** Many messages repeat verbatim
   (permission-denied variants, `{Entity} not found`, `At least one field must be provided`). Collapse
   into shared `common.*` keys (see §4).
5. **All custom domain errors are out of scope.** Where storage/signature errors reach HTTP they are
   already remapped to **generic English strings at the `libs/api/media` filter/controller sites**
   (those mapping-site strings _are_ in scope and counted under `media`).

---

## 2. Summary counts (in-scope)

| Lib                                  | Exception msgs | Success `message:` | Notes                                                                      |
| ------------------------------------ | -------------: | -----------------: | -------------------------------------------------------------------------- |
| libs/api/event                       |             32 |                 21 | largest surface                                                            |
| libs/api/media                       |             35 |                  1 | + generic strings from StorageExceptionFilter mapping sites                |
| libs/api/friendship                  |             14 |                  3 |                                                                            |
| libs/common/quota                    |             12 |                  — | incl. `QuotaExceededException` (msg centralized in ctor) + 1 validator msg |
| libs/api/game                        |              8 |                  3 |                                                                            |
| libs/api/webhook-subscription        |              8 |                  5 | 1 dynamic (caller-supplied) message                                        |
| libs/api/game-collection             |              7 |                  3 |                                                                            |
| libs/api/game-gateway                |              6 |                  0 | 2 dynamic `error.message` pass-through (see §6)                            |
| libs/common/permissions              |              5 |                  — | ForbiddenException only; custom error out of scope                         |
| libs/api/household                   |              4 |                  3 |                                                                            |
| libs/api/safe-http                   |              4 |                  — | + 2 custom-validator messages (admin)                                      |
| libs/api/game-import                 |              3 |                  5 | worker context + `SAFE_MESSAGE` client-safe copy map                       |
| libs/api/system-settings             |              2 |                  — | operator-facing "run the seed" invariants                                  |
| libs/api/quota                       |              1 |                  1 |                                                                            |
| libs/api/feedback                    |              1 |                  1 | + 1 custom-validator message                                               |
| libs/api/language                    |              1 |                  — |                                                                            |
| libs/api/well-known                  |              1 |                  — |                                                                            |
| libs/api/gateway-registry            |              1 |                  — | NotImplementedException                                                    |
| libs/common/actor-context            |              1 |                  — | `audit-context.service.ts:53` ForbiddenException                           |
| **libs/api/actor-context-transport** |         **19** |                  — | **LOW PRIORITY** — 2 HTTP, 17 internal gRPC                                |
| **Totals**                           |       **~165** |            **~42** |                                                                            |

Validation (whole repo): **1** inline `message:` + **3** custom `ValidatorConstraint` messages.

---

## 3. Phase 3 migration checklist (by lib)

Ordered roughly by value/size. Each is an independent unit of work (good for parallel owners).

- [x] `libs/api/event` — **DONE**. Actual surface was **~50 exceptions + 22 success** (not 32/21):
      the original `throw new *Exception` sweep **missed every `assert(cond, new *Exception(...))`** (18
      in this lib, incl. multi-line asserts where the exception sits on a later line). **Remaining libs
      must re-grep for `new [A-Z]\w*Exception\(` (not only `throw new`)** to avoid under counting. Copy
      normalized: event-not-found unified to game's `"… with ID {id} …"` form. isEnum message uses
      `{constraints.1}`; enum-list stringification may differ slightly from class-validator's default
      (en-only, no test asserts it — accepted).
- [x] `libs/api/media` — **DONE**. Real surface was **41 exceptions + 1 success** (inventory said
      35/1; no `assert()` throws in this lib). The two **controller-scoped** filters
      (`StorageExceptionFilter`, `MulterExceptionFilter`) render responses themselves, so they now
      resolve `t()` markers via the shared `translateException` helper (`@bge/i18n`).
      `MulterExceptionFilter` was narrowed from a bare `@Catch()` to `@Catch(MulterError)` (adds
      `@types/multer`) — the old catch-all had been silently shadowing the **global** exception _and_
      validation filters for the whole media-object controller (a latent #142 side-effect; validation
      errors there now format correctly again). Fixed `storage-exception.filter.ts` passing the raw
      `exception.message` to clients (info-leak → generic `errors.storage.insufficient`).
      `QuotaExceededException` is left to the quota lib (message centralized in its ctor); its
      `'storage_bytes'` metric-key args carry a `no-restricted-syntax` escape-hatch.
- [x] `libs/api/friendship` — **DONE**. Actual surface was **15 exceptions + 3 success** (inventory said
      14): the sweep missed the `return new ForbiddenException(...)` in `mapMissingToForbidden` — a non-`throw`
      construction, exactly the under count §3 warns about. No `assert()` throws in this lib. Added
      `errors.user.not_found` (new shared key for the addressee lookup; other user-referencing libs can adopt
      it). The dynamic `respond` success (`Friendship ${status}`) became per-status keys
      `success.friendship.{accepted,declined,withdrawn,blocked}` so each stays a whole translatable sentence.
      Logger line (`mapMissingToForbidden`) left English.
- [x] `libs/common/quota` — **DONE**. 11 service exceptions + `QuotaExceededException` ctor message + 1
      validator msg. The exception carries machine-readable fields (`resource`/`scope`/`limit`/…) beside its
      message, so `translateException` gained a branch that translates a marker nested in a structured body's
      `message` field in place (see [translated-exceptions.md](./translated-exceptions.md) → Structured bodies).
      The registry's 3 plain `Error` throws stay English (internal, not `*Exception`). Namespace `errors.quota.*`
      / `success.quota.*` (import alias `@bge/quota`; the api lib is `@bge/quotas` — no collision). Added
      `validation.nonNegativeIntegerString` (preserves the exact `@IsNumberString` copy via `{property}`).
- [x] `libs/api/game` — 8 exceptions + 3 success — **DONE (Phase 3 spike)**; established the
      success-response interceptor, catalog conventions, and #145 guardrail (see
      [translated-responses.md](./translated-responses.md))
- [x] `libs/api/webhook-subscription` — **DONE**. 8 exceptions (7 literal + the 1 dynamic §6 msg) + 5 success.
      The dynamic `requireAbilities(message)` was resolved at its 3 call sites (per §6): the helper's param
      became `I18nMessage` and each caller passes a distinct `t()` key (`forbidden_create`/`forbidden_change_events`/
      `forbidden_reactivate`). The empty-update throw reuses shared `common.at_least_one_field` (adds "for update"
      — accurate, it's the update path). Namespace `errors.webhook_subscription.*` (9 keys) / `success.webhook_subscription.*`
      (5 keys). Both specs needed ZERO edits (assert exception types / definedness, never strings). **DTOs are in a
      separate lib (`@bge/webhooks` / `libs/common/webhooks`)** — bare decorators, no custom message literals, so no
      guardrail trip; that lib's validator-annotation sweep is deferred to its own item.
- [x] `libs/api/game-collection` — **DONE**. Real surface was **8 exceptions + 3 success** (inventory
      said 7): the sweep missed the `return new NotFoundException(...)` in `mapMissingToNotFound` — a
      non-`throw` construction, exactly the under count §3 warns about. No `assert()` throws. Fully
      mechanical (no custom filters): services throw `t()` markers to the global `I18nExceptionFilter`,
      controller returns `t('success.game_collection.*')` markers. New per-entity namespaces
      `errors.game_collection.{not_found,release_platform_mismatch}`, `errors.platform_game.not_found`,
      `errors.game_release.not_found` (translatable nouns baked into the frame, only IDs interpolated);
      reused shared `common.at_least_one_field`. `success.game_collection.{added,updated,removed}`. No new
      validation keys — all 4 DTOs annotated against existing `validation.*`. Only the controller spec's
      one `message: expect.any(String)` needed editing (→ `t()` marker, `toMatchObject` structural); the
      service spec asserts exception TYPES only (zero edits). Guardrail enabled.
- [x] `libs/api/game-gateway` — **DONE**. 6 service exceptions + fixed the 2 raw `error.message`
      pass-through **info-leaks** (§6). No `assert()`, no success `message:` bodies. New per-entity
      namespace `errors.game_gateway.{not_found,not_found_or_denied,connect_failed,disconnect_failed}`
      (two distinct not-found messages: `getById` says "not found or access denied" — the ability-scoped
      `findUniqueOrThrow` can't distinguish the two — while `update`/`delete` count first and say plain
      "not found"). The controller's connect/disconnect `catchError` now returns a generic translated
      marker (`connect_failed`/`disconnect_failed`) rendered by `I18nResponseInterceptor`; the raw
      coordinator error stays server-side in the logger only. Reused `common.at_least_one_field` /
      `common.forbidden.{update,delete}`. No new validation keys — `CreateGameGatewayDto` annotated
      against existing `validation.{isString,isPositive,max,isBoolean,isIn}`; `UpdateGameGatewayDto` is
      `PartialType(CreateGameGatewayDto)` so it inherits the annotations. Both specs assert exception
      TYPES / DTO fields only — zero edits.
- [x] `libs/common/permissions` — **DONE**. 5 ForbiddenException (surface matched inventory; no
      `assert()` throws, no success bodies, no DTOs). Fully mechanical (no custom filters): the guard and
      `AbilityService` throw `t()` markers caught by the global `I18nExceptionFilter`. Reused shared
      `common.forbidden.access` (ability.service `getResourceConditionsForAbilities` ×2) and new
      `common.forbidden.action` (policies.guard ×2 — "You do not have permission to perform this action.").
      New `errors.api_key.not_found_or_revoked` for the one unique message (revoked/missing key on ability
      resolution). No new validation keys. Both specs assert exception TYPES / delegation only (zero edits).
      Guardrail enabled on `permissions/eslint.config.mjs`; `nx sync` added the i18n tsconfig ref (first
      `@bge/i18n` import).
- [x] `libs/api/household` — **DONE**. Real surface was **9 exceptions + 3 success** (inventory said
      4/3): the `throw new` sweep missed **4 `assert(cond, new *Exception(...))` throws** (3 not-found +
      BCP 47 tag validation), exactly the under count §3 warns about. Fully mechanical (no custom filters).
      New `errors.household.{not_found,invalid_language_tag,language_tag_unsupported}` (IDs / user-supplied
      tags interpolated; not-found normalized to the "with ID {id}" frame). Reused shared
      `common.forbidden.{view,update,delete}` (the view/delete throws' "this household" copy normalized to
      the generic "this resource" — service spec asserts TYPES only) and `common.at_least_one_field`.
      `success.household.{created,updated,deleted}` (updated/deleted keep the `{id}`). No new validation
      keys — `CreateHouseholdDto` annotated against existing `validation.{isString,isEnum}`;
      `UpdateHouseholdDto` is `PartialType(CreateHouseholdDto)` so it inherits. Both specs assert exception
      TYPES / delegation only — zero edits. Guardrail enabled.
- [x] `libs/api/safe-http` — 4 exceptions + 2 custom-validator messages
- [x] `libs/api/game-import` — **DONE**. Only 1 of the 3 exceptions is HTTP-facing
      (`import-status.service.ts` batch lookup → `errors.game_import.batch_not_found`); the other two are
      thrown inside BullMQ worker processors, caught by `sanitizeImportError`, and land only in `Job.error`
      plus operator logs, so they stay English (both use string concatenation, so the #145 guardrail's
      direct-literal selectors don't trip — no eslint-disable needed). The `SAFE_MESSAGE` map stays English
      for worker-emitted surfaces (webhook/notification); only the REST read-back is localized —
      `toJobDto` maps `errorCode → t(IMPORT_FAILURE_MESSAGE_KEYS[code])` behind `I18nResponseInterceptor`.
      Deferred worker-side localization (notification + webhook) → new issue **#188**. Added
      `errors.game_import.batch_not_found` + `errors.game_import.failure.*`, `success.game_import.enqueued`,
      `validation.isUUID`. Both DTOs annotated.
- [x] `libs/api/system-settings` — **DONE**. 2 exceptions (surface matched inventory; no `assert()`, no
      success bodies). Operator-facing "run the seed" invariants →
      `errors.system_settings.{not_found,multiple}` (mirrors the `safe_http.no_policy` / `multiple_policies`
      singleton-invariant pattern). `UpdateSystemSettingsDto` annotated (`@IsBoolean` ×4, `@IsNumber`)
      against existing `validation.isBoolean` + new `validation.isNumber`; `@IsOptional()` left unannotated.
      Both specs are `should be defined` only (zero edits). Guardrail enabled; `nx sync` added the i18n
      tsconfig ref (first `@bge/i18n` import).
- [x] `libs/api/quota` — **DONE**. 1 exception (reuses `errors.quota.unknown_resource`) + 1 success
      (`success.quota.set`). Controller spec updated to assert the `t()` marker.
- [x] `libs/api/feedback` — **DONE**. 1 exception + 1 success + 1 custom-validator message. The
      exception (`banUser` user-not-found) reuses the shared `errors.user.not_found` key. Success
      `message:` → `success.feedback.submitted` (the `SubmitFeedbackResponse.message` type widened from
      `string` to `I18nMessage`; the interceptor renders it to a string pre-serialization). The
      `MaxJsonBytesConstraint.defaultMessage()` now returns `i18nValidationMessage('validation.maxJsonBytes')`
      — but with `value` stripped from the args, because the factory JSON-serializes `args.value` and the
      rejected payload may be oversized or non-serializable (BigInt/circular); the catalog string only uses
      `{property}` + `{constraints.0}`. DTO annotation added `validation.{isObject,arrayMaxSize,isISO8601,maxJsonBytes}`.
      The internal `findCreatePermission` plain `Error` stays English (§5). Controller spec updated to assert
      the `t()` marker; validator spec unaffected (asserts booleans).
- [x] `libs/api/language` — **DONE** (was the #143 exemplar; `errors.language.not_found` already
      converted). This pass only enabled the #145 guardrail on its eslint config.
- [x] `libs/api/well-known` — **DONE**. 1 exception (`getSecurityTxt` → `errors.well_known.security_txt_not_configured`;
      concatenated literals joined into one catalog entry per §6). The `assert(settings, '…')` in
      `strategy.service.ts` stays English — a `node:assert` invariant that surfaces as a generic 500, never a
      client-facing body (§5). Controller spec's "descriptive message" test rewritten to assert the marker via
      `getResponse()`.
- [x] `libs/api/gateway-registry` — **DONE**. 1 exception (`GatewayCredentialsFactory` →
      `errors.gateway_registry.auth_type_not_implemented`, keeps `{authType}`). No spec asserted the message
      (zero spec edits).
- [x] `libs/common/actor-context` — **DONE** (#189). 1 exception (`audit-context.service.ts:66`,
      `getActingUserId` refusing a `system`/`external`/`plugin` actor) → `errors.actor_context.not_user_attributable`,
      keeps `{kind}` (a non-translatable identifier). `@bge/i18n` imports `AuditContextService` /
      `LOCALE_CLS_KEY` from this lib, so importing `t` from `@bge/i18n` here would form a circular project
      reference; it imports from `@bge/i18n-core` instead, the lower lib #189 extracted the primitives
      and catalogs into. The plain `Error`s at `:56` and `:78` stay English (§5). Spec gained a test
      asserting the marker via `getResponse()`. Guardrail enabled.
- [x] `libs/api/actor-context-transport` — **DONE**. Real surface was **21** (inventory said 19): 4 HTTP
      and 17 gRPC. The 4 HTTP throws are "Invalid API key" and "Impersonated sessions are not supported",
      each in both `http-actor.middleware.ts` and its unwired twin `http-actor.interceptor.ts` (the second
      pair was added by #408). They became `errors.api_key.invalid` (beside the existing
      `not_found_or_revoked`) and `errors.auth.impersonated_session`, which the WS refusal in #180 can
      reuse. The middleware throws before `LocaleResolutionMiddleware` runs, so both render in the
      fallback locale (see [translated-exceptions.md](./translated-exceptions.md)). The 17 gRPC frames
      stay English (§5), and the guardrail exempts those two files by name. Specs assert the markers via
      `getResponse()`. The gRPC spec's English assertions are unchanged.
- [x] `libs/api/audit-log` — **DONE**. A DTO-only lib: it had no exception strings, so the exception
      sweep never listed it, but `ListAuditLogsQueryDto` carried 15 bare decorators. As in each DTO-only
      row below, a spec asserts that every failing constraint names its `validation.*` key (the
      `validationCatalogKeys` helper in `@bge/testing`), and the guardrail is enabled.
- [x] `libs/common/webhooks` — **DONE** (DTO-only). `CreateWebhookSubscriptionDto` (9) and
      `UpdateWebhookSubscriptionDto` (6), the DTOs the `webhook-subscription` item above deferred. This
      sweep's new keys, `validation.arrayNotEmpty`, `validation.arrayUnique` and
      `validation.each.{isString,isIn}`, copy class-validator's default wording, and the `@bge/i18n`
      real-catalog spec pins that they render identically. The `each` keys keep the "each value in "
      prefix that a custom message drops. The five `each: true` sites annotated in earlier rows now use
      them too.
- [x] `libs/api/game-search` — **DONE** (DTO-only). The HTTP `SearchQueryDto` (6). Its WS DTOs are in the
      #503 row below.
- [x] `libs/api/notifications` — **DONE** (DTO-only). `MarkReadDto` (4).
- [x] `libs/api/user` — **DONE** (DTO-only). `UserSearchQueryDto` (2).
- [ ] `libs/common/shared` pagination/search DTOs and the WS `SearchStartDto` / `SearchCancelDto` — **#503**.
      17 bare decorators plus `SkipWithinCeiling.defaultMessage()` in `@bge/shared`, and 8 on the WS DTOs.
      The WS-reachable ones wait on #180: until it puts `I18nValidationPipe` on the gateway, a marker would
      reach WS clients raw. `@bge/shared` does not depend on `@bge/i18n` yet, and #503 decides how it
      gets the marker.

---

## 4. Recommended shared keys (dedup)

**Superseded (#144):** this was the plan before the migration, and the names below did not land as
written. The shared keys are `common.forbidden.{view,update,delete,remove,access,action}` and
`common.at_least_one_field`. Not-found messages became per-entity `errors.<entity>.not_found` keys, and
"Invalid API key" became `errors.api_key.invalid`, since it has one live site. The §3 rows record the
keys each lib uses.

These strings repeat across many libs — make them shared `common.*` keys, not per-site:

- `common.forbidden.resource` — "You don't have permission to {action} this resource." (view/update/delete/remove) — appears in event, game, game-gateway, household, occurrence, …
- `common.forbidden.action` — "You do not have permission to perform this action." (permissions guard ×2)
- `common.forbidden.access` — "You don't have permission to access this resource." (permissions ×2)
- `common.notFound.entity` — "{Entity} with id {id} not found" — friendship, household, language, safe-http, game, game-collection, game-gateway, webhook-subscription, event, media, feedback, quota
- `common.badRequest.noFields` — "At least one field must be provided for update" — game, game-collection, game-gateway, household
- `common.unauthorized.apiKey` — "Invalid API key" — actor-context-transport ×2

---

## 5. Out of scope (confirmed) — custom/domain error classes

All operator/developer-facing. Where they touch HTTP they are remapped to generic English at the
mapping site (which is in scope and counted under `media`). Do **not** translate these:

- **Storage** (`libs/storage/*`): `StorageMisconfiguredError`, `DriverNotRegisteredError`,
  `InvalidObjectKeyError`, `ObjectNotFoundError`, `SignatureInvalidError`, `SignatureExpiredError`,
  `RangeError`, `ProbeTimeoutError`. StorageExceptionFilter → generic `503 Storage temporarily
unavailable`; signature/not-found remapped inside `media-object.service.ts` to
  `Invalid signature` / `Signed URL has expired` / `Media not found` (those strings **are** in scope).
- **secure-http** (`libs/common/secure-http`): `DnsResolutionError`, `SsrfRejectionError`,
  `RedirectToDisallowedTargetError`, `RedirectLimitExceededError`, `RequestTimeoutError`,
  `OutboundNetworkError`, `InvalidRequestUrlError` — never reach HTTP (outbound retry classification).
- **queue** (`libs/queue/*`): `SinkNotRegisteredError`, `FeedbackSinkMisconfiguredError`,
  `WebhookDeliveryFailedError` — worker/boot-time, never HTTP.
- **actor-context** (`libs/common/actor-context`): `TypeError` + plain `Error` invariants — dev-facing.
- **permissions**: `AbilityContextNotPrimedError` + plain `Error` — dev-facing.
- **quota registry** (`libs/common/quota/.../registry`): 3 plain `Error` throws — internal.
- **actor-context-transport gRPC interceptors** (#144): 17 `HttpException` frames — 16 in
  `GrpcInternalActorInterceptor` (registered only on `gateway-coordinator`) and 1 in the unwired
  `GrpcActorInterceptor`. These are real exception classes, not custom errors, but no caller ever reads
  them: Nest's `BaseRpcExceptionFilter` answers any non-`RpcException` with "Internal server error" and
  only logs the exception. A `t()` marker body would make that log line the generic class phrase (#501),
  so they stay English. The lib's eslint config exempts those two files from the guardrail by name.

---

## 6. Special-handling callouts

- **Dynamic / non-literal messages** (need per-case decisions, not straight extraction):
  - `webhook-subscription.service.ts:223` — `ForbiddenException(message)` where `message` is
    caller-supplied via `requireAbilities(message)`; translate at the call sites, not here.
  - `game-gateway.controller.ts:131,164` — response `message:` passes through raw caught
    `error.message`. **Not just an i18n gap — a potential info leak.** Replace with a translated,
    sanitized string.
  - `grpc-internal-actor.interceptor.ts:143` — embeds `(error as Error).message` in a
    BadRequestException. **Resolved (#144):** it stays English with the other gRPC frames (§5).
- **Centralized-in-constructor:** `QuotaExceededException` builds its message once in its ctor
  (`Quota for "{resource}" exceeded at {scope} scope`) — one key, all throw sites inherit it.
- **`SAFE_MESSAGE` map** (`game-import/src/lib/utils/sanitize-import-error.ts`) — 4 client-safe
  strings already designed as user-facing copy; ideal first candidates
  (`The requested game could not be found on the gateway.`, etc.).
- **Concatenated literals:** several messages are built from 2 string fragments across lines
  (event occurrence, well-known security.txt, safe-http wildcard, quota scope, game-import,
  gateway-registry). Join into a single catalog entry.
- **Worker-context throws** (`game-import` processors): thrown off the HTTP path; some are later
  sanitized before reaching clients. Localize with an explicit `lang` when Phase 4 wires worker locale.
- **`actor-context-transport` gRPC frames (17):** on internal service-to-service channels — technically
  `HttpException` but never surfaced to callers. **Resolved (#144):** they stay English (§5).
- **WebSocket copy** — #180, not this inventory's sweep. The gateways send English straight through
  `client.emit`, bypassing any filter: `auth:error` in `authenticated.gateway.ts`, the three refusals in
  `build-client-data.ts`, and `SearchError` in `search.gateway.ts`. `WsValidationFilter` forwards
  validation messages unchanged, which is why the WS DTOs wait on #180 (§3, #503). #180's amendment
  lists every site.

---

## 7. Validation messages (full list)

| file:line                                                       | source                                            | message                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| libs/common/quota/.../dto/set-quota.dto.ts:18                   | inline `@IsNumberString` message                  | `limit must be a non-negative integer string`                                                                                |
| libs/api/feedback/.../validators/max-json-bytes.validator.ts:51 | `MaxJsonBytesConstraint.defaultMessage()`         | `{property} exceeds the maximum serialized size of {maxBytes} UTF-8 bytes`                                                   |
| libs/api/safe-http/.../dto/validators.ts:33                     | `IsHostnameOrWildcardConstraint.defaultMessage()` | `Each entry must be a valid hostname or wildcard (e.g. "example.com" or "*.example.com")`                                    |
| libs/api/safe-http/.../dto/validators.ts:71                     | `IsCidrConstraint.defaultMessage()`               | `Each entry must be a valid CIDR (e.g. "10.0.0.0/8" or "fc00::/7"). Single IPs require explicit prefix (e.g. "10.0.0.5/32")` |
| libs/common/shared/.../dto/pagination-query.dto.ts:77           | `SkipWithinCeiling.defaultMessage()` (#230)       | `page is too deep: (page - 1) × limit must not exceed {DEFAULT_MAX_OFFSET}` — pending #503                                   |

Everything else = class-validator **built-in defaults**, which are **NOT** auto-translated. Phase 2
(#142) installs `I18nValidationPipe` + the `validation.*` catalog + the convention; actually localizing
these requires adding `i18nValidationMessage<I18nTranslations>('validation.KEY')` to each decorator. #144
annotated every in-scope DTO except the `@bge/shared` pagination/search DTOs and the WS search
DTOs, which #503 tracks (§3). The #145 guardrail cannot catch a bare decorator: it only matches string
literals, and a bare `@IsString()` has none.

---

_Full per-site message tables (every throw with exact text + interpolation args) were captured during
the sweep and can be regenerated per lib on demand; the checklist in §3 plus the shared-key plan in §4
is what Phase 3 owners work from._
