# Board Games Empire — Backend Roadmap

> Living document. Update as priorities shift, dependencies land, and the
> picture clarifies. Last meaningful update: post-PR-6 (client) merge, May 2026.

This roadmap describes the backend work that supports the BGE client through
its device-installable alpha and beyond. Complements the GitHub issue tracker
— issues hold the detailed scopes, this doc holds the *order*, *dependencies*,
and *deferred decisions*.

## Architectural ground truth

For anyone (human or LLM) picking this up cold:

- **Self-hosted philosophy.** Every BGE deployment is independent. No central
  aggregation, no third-party data sharing by default. Server admins configure
  what flows where (bug reports, analytics) via `/.well-known/bge-identity`.
- **NestJS + Prisma + Postgres.** Standard structure: feature modules with
  controllers + services, Prisma as the ORM, postgres as the DB.
- **BetterAuth for authentication.** Plugins installed: `admin`, `anonymous`,
  `bearer`, `deviceAuthorization`, `genericOAuth`, `lastLoginMethod`, `oneTap`,
  `oneTimeToken`, `openAPI`, `twoFactor`. JWT plugin NOT installed (opaque
  session tokens). Endpoints under `/api/auth/...`.
- **cuid2 for IDs.** Backend explicitly uses cuid2 (not Prisma's default `cuid()`
  which is v1). All IDs round-trip through clients.
- **Gateway architecture for game imports.** Game data sourced from external
  gateways (BGG, IGDB, etc.) and merged into local catalog. Mapper layer
  per gateway. Language coordination service in flight (#39).
- **Well-known discovery is the contract.** Clients hit `/.well-known/bge-identity`
  first; server advertises auth strategy, endpoints, capability flags,
  version requirements, and configured sinks.

## What's done as of May 2026

- BetterAuth wired up with email/password sign-in/sign-up + session management.
- Game search and import from external gateways working.
- BGG and IGDB mappers implemented (with IGDB DLC mapping still pending — #40).
- `.well-known/bge-identity` endpoint exposing `ServerIdentity` (auth strategy,
  session/signout endpoints).
- Prisma schema for Game, PlatformGame, GameCollection, Household,
  HouseholdMember, plus auth-related tables.
- CORS configured via NestJS `enableCors`. **Known issue**: current
  `origin: [..., '*']` combined with `credentials: true` is invalid per CORS
  spec — browsers reject it. Fix coordinated with client Phase 1.
- Various supporting infrastructure (logging, error handling) at baseline level.

## What's NOT yet done (alpha-critical, in order)

### Phase 1 — Well-known + bug-report infrastructure (parallel to client Phase 1)

Filed issues:
- **#44 Bug report data model + retention policy** — Prisma `BugReport` model
  with `BugReportStatus` enum, `userRedactedFields[]`, `redactionApplied`
  flags. Retention policy: hard-delete after N days (suggest 90). GDPR
  account-deletion option flagged for follow-up.
- **#45 Bug report submission API** — `POST /api/feedback/bug-report`.
  Authenticated or anonymous. Rate-limited per-IP + per-user. 256KB payload
  cap.
- **#46 Advertise bugReportSink in well-known** — Optional alternate sink URL
  for routing reports to Sentry / GlitchTip / etc. Self-hoster choice; client
  routes accordingly. Includes opt-out signal.
- **#47 Extend well-known with version + capability fields** — minClientVersion,
  maxClientVersion, features map (per-deployment capability flags),
  anonymousAuthEnabled, wellKnownSchemaVersion. Companion to the client's
  #13 (honor these fields).
- **#49 Advertise analyticsSinks in well-known** — Optional analytics sink
  list; multi-sink supported, format strings (posthog / plausible / bge /
  custom). Companion to client's #17.
- **#48 Audit log pattern for sensitive mutations** — Append-only
  `AuditLogEntry` model + `AuditLogService` for capturing actor/action/target/
  before/after on sensitive operations. Triaging endpoints deferred to admin-UI
  work post-alpha.

### Phase 2 — Collection management API (after client Phase 1, supports client Phase 5)

The client's alpha demo flow (search → add → see persist) needs server-side
endpoints for collection mutations. Currently the client's
`GameCollectionRepositoryImpl` enqueues `AddToCollectionOperation` /
`UpdateCollectionOperation` / `RemoveFromCollectionOperation` operations but
the server doesn't have the matching endpoints.

To file:
- **Collection CRUD endpoints**: GET /api/me/collection, POST /api/me/collection,
  PATCH /api/me/collection/:id, DELETE /api/me/collection/:id.
- **Collection sync endpoint**: applies a batch of `SyncOperation`s in one
  transactional call. Returns canonical IDs for newly-created rows so the
  client can remap. Idempotent (same operation applied twice is a no-op).
- **Collection conflict resolution policy**: server-wins for now; per-field
  conflict signals in responses for the future server-driven-dirty-merge
  flow (per the `TODO(server-driven-dirty-merge)` markers in the client repo).

### Phase 3 — Household creation/management API (supports client v0.2)

The client's `HouseholdRepository` is currently read-cache only. Mutations
are Phase-4 client scope. The backend needs corresponding endpoints.

To file:
- **Household CRUD**: POST /api/households, PATCH /api/households/:id,
  DELETE /api/households/:id.
- **Membership management**: POST /api/households/:id/members, DELETE
  /api/households/:id/members/:userId, PATCH /api/households/:id/members/:userId
  (for role changes).
- **Invitation flow**: invite tokens, accept/decline endpoints, expiration.
- **Audit log integration** (depends on #48): every membership and role
  change writes an audit entry in the same transaction.

### Phase 4 — User data / account lifecycle endpoints

To file:
- **User data export**: GET /api/me/export — returns a structured bundle the
  client's `UserDataExporter` (#11 client) merges with its local-data export.
  Covers data the client doesn't cache (audit log, server-only preferences,
  bug reports the user submitted, etc.).
- **Account deletion**: DELETE /api/me/account with optional flags for
  what to retain (audit log entries about the user, bug reports they
  submitted). GDPR Article 17.
- **Bug-report admin triage endpoints** (companion to #44/#45): GET
  /api/feedback/bug-reports (list, paginated, filterable), PATCH
  /api/feedback/bug-reports/:id (status, triage notes, assignee), DELETE
  /api/feedback/bug-reports/:id. Admin-role gated.

### Phase 5 — Push notification registration (supports client v0.2 push impls)

To file:
- POST /api/me/push/register — accept the client's `PushRegistration` (#15
  client), return the server-side record.
- DELETE /api/me/push/register/:registrationId — unregister.
- Server-side push-sending machinery — design when push features are
  actually wired (chat notifications, invite alerts, etc.).

### Phase 6 — Media handling endpoints

Multi-issue topic, see "Design discussions still pending" below. Once the
client-side design is settled, file:
- Image upload endpoints with content-addressed storage, EXIF stripping,
  variant generation (thumbnail, display, full).
- Video upload endpoints (if videos are in scope).
- Storage backend strategy: filesystem by default, S3-compatible alternative
  configurable via env. Self-hosted operators choose.
- Per-context rules (profile pics, collection condition, event/session
  media, household banners) — different validation, retention, visibility.

### Phase 7 — Play sessions API (supports client v0.2+)

To file when sessions feature begins:
- Session CRUD endpoints.
- TZ-aware datetime models for session scheduling (sessions are
  *local-time-at-location* events, not UTC).
- Score/play-stat aggregation endpoints.
- Campaign management.

### Phase 8+ — Social

Friendship, events, RSVP, chat. Each its own design exercise. Chat is the
first real WebSocket use case (Socket.IO already chosen).

## Already-filed structural issues (predate this roadmap)

- **#21 Game Merging** — Fuzzy-match newly imported games against existing
  catalog, suggest merges. `GameMergeCandidate` model designed.
- **#27 API Keys** — User-scoped API key generation. Needs BetterAuth api
  plugin re-evaluation; scopes vs the existing better-auth model don't quite
  align.
- **#36 Release-level frozenAt** — Protect user-curated edition data from
  unconditional overwrite during import refresh.
- **#37 Language model field renames** — code → iso6393, abbreviation →
  iso6391, add ietfTag.
- **#38 LanguageGatewayLink table** — Replace BGG mapper's hardcoded language
  map with DB-backed gateway-language link table.
- **#39 Coordinator-side LanguageTranslationService** — Translate user locale
  ↔ gateway-native format for outbound/inbound coordination.
- **#40 IGDB DLC mapper population** — Wait for concrete UI consumer before
  populating.

These fold into the phase plan as supporting work; most aren't alpha-critical
but advance the gateway / catalog quality story.

## Design discussions still pending (not yet issues)

These have direction but not enough specifics to file useful issues:

- **Media handling architecture.** Storage backend, content addressing,
  upload pipeline, processing (resize / crop / EXIF strip), video specifics,
  CDN, per-context rules. Probably 6+ issues across client + backend once
  designed.
- **Bug-report admin UI.** Triage endpoints will land before the UI; the UI
  itself is post-alpha.
- **Server-side analytics ingestion** (if any). Today the model is "advertise
  external sinks and let admin configure." A self-hosted "BGE analytics"
  service that listens at a configurable endpoint could be added if there's
  demand, but not the alpha scope.

## Outstanding work for future investigation

**Backend feature examination still pending.** A systematic walk through
the backend's existing modules looking for gaps — DTOs that don't match
client expectations, missing indexes, places where the schema and the
client's wire format have diverged, etc. Promised but not yet executed
in this round. Next major task on the backend.

## Cross-cutting concerns

- **CORS fix** (origin `'*'` + credentials true is invalid). Coordinated
  with client Phase 1. Trivial fix; trip-up point for browser-platform
  alpha.
- **Rate limiting** generally — applied per-endpoint as features land. The
  bug-report API (#45) is the first explicit consumer. Reusable middleware
  worth extracting once two or three endpoints want it.
- **Audit logging** (#48) — once landed, every sensitive mutation in every
  feature module integrates with the audit service.
- **OpenTelemetry** for backend tracing — separate from client analytics,
  doesn't require client participation. Land when there's a debugging
  need; not alpha-critical.

## Pointers

- **Issue tracker**: open issues in this repo. See phase mappings above.
- **Client roadmap**: `BoardGamesEmpire/board-games-empire-client:docs/ROADMAP.md`.
- **Client issue tracker**: `BoardGamesEmpire/board-games-empire-client` —
  open issues #7-#17 cover client-side foundation work that pairs with the
  backend phases above.
