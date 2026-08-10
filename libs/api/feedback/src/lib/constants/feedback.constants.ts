/**
 * Compile-time constants for the feedback feature.
 *
 * Runtime-tunable *policy* values (retention days, redaction toggle) live on
 * `SystemSetting`. Hard transport/protocol limits live here because making
 * them runtime-mutable requires custom ThrottlerStorage / dynamic body parser
 * — gold-plating for v1.
 *
 * The 256 KB transport-layer cap the field caps below sit under is enforced
 * globally at the app body-parser (`MAX_REQUEST_BODY_BYTES` in `@bge/auth`,
 * wired into the better-auth JSON parser), not here — better-auth owns the
 * parser lifecycle for the whole app.
 */

/** Field-level cap on the `message` string. */
export const FEEDBACK_MAX_MESSAGE_LENGTH = 10_000;

/**
 * Field-level cap on the optional `stackTrace` string. Generous enough to
 * accommodate deep async chains and framework noise; the client is
 * expected to truncate tail-preserving when a trace exceeds this. The
 * backend rejects anything past the cap — no server-side truncation of
 * client-supplied content (pre-alpha: fail loudly).
 */
export const FEEDBACK_MAX_STACK_TRACE_LENGTH = 32_768;

/** Field-level cap on the optional `title` string. */
export const FEEDBACK_MAX_TITLE_LENGTH = 200;

/** Field-level caps on free-form client metadata strings. */
export const FEEDBACK_MAX_APP_VERSION_LENGTH = 64;
export const FEEDBACK_MAX_PLATFORM_LENGTH = 32;
export const FEEDBACK_MAX_LOCALE_LENGTH = 32;

/**
 * Wire-contract cap for `CreateFeedbackReportDto.clientRequestId`. Generous
 * enough for any client id scheme (the Flutter client mints a cuid2 at compose
 * time), tight enough that the unique index never carries unbounded input.
 * Mirrors `HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH`.
 */
export const FEEDBACK_MAX_CLIENT_REQUEST_ID_LENGTH = 128;

/**
 * DB name of the `@@unique([userId, clientRequestId])` index, as mapped in
 * `feedback-report.prisma`.
 *
 * NO LONGER A DISCRIMINATOR. `recoverKeyedSubmit` used to match this against a
 * P2002's `meta.target`; Prisma 7 with the `PrismaPg` driver adapter reports no
 * usable `target`, so the match never fired and every keyed retry became a
 * 500 — the exact failure #251 exists to remove, reinstated silently. Replay now
 * keys off the presence of a row under `(userId, clientRequestId)`.
 *
 * Retained as the name of record for the index, so a rename in the schema stays
 * visible from TypeScript.
 */
export const FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT = 'feedback_report_user_client_request_id_unique';

/** Cap on the `userRedactedFields` array length. */
export const FEEDBACK_MAX_REDACTED_FIELDS = 64;

/**
 * UTF-8 byte cap on the serialized `breadcrumbs` array.
 *
 * The client buffers up to 100 sanitized crumbs (see Dart
 * `BreadcrumbBuffer.defaultCapacity`); a typical entry serializes to a few
 * hundred bytes, so 64 KB leaves comfortable headroom while staying well
 * under the 256 KB transport cap. Enforced via `@MaxJsonBytes` on the DTO.
 */
export const FEEDBACK_BREADCRUMBS_MAX_BYTES = 64 * 1024;

/**
 * Tiered submission rate limits (issue #45), enforced per rolling hour. The
 * per-user tier tracks the authenticated user; the per-IP tier tracks the
 * source address. Both apply to every submission — whichever trips first wins.
 *
 * TODO: migrate to SystemSetting once a dynamic ThrottlerStorage exists in the
 * codebase.
 */
export const FEEDBACK_USER_THROTTLE_LIMIT = 30;
export const FEEDBACK_IP_THROTTLE_LIMIT = 100;
export const FEEDBACK_THROTTLE_TTL_SECONDS = 60 * 60;

/**
 * Slug for the `create:feedback_report` permission. Banning a user is
 * implemented as a `UserPermission` row with `inverted: true` against this
 * permission, so the slug is hot-pathed through the ban/unban code.
 */
export const FEEDBACK_CREATE_PERMISSION_SLUG = 'create:feedback_report';
