import type { PermissionSlug } from '@bge/database';

/**
 * How long an owner's delete stays undoable by the household's owners (#175).
 * `deleteHousehold` stamps each owner's recovery grant with this expiry and
 * reports it as `restorableUntil`; after it, only server staff can restore.
 *
 * A constant rather than an environment variable: nothing about a deployment
 * should need a different window to work, and a knob nobody has asked for is
 * one more thing to set wrong. Promote it to an operator setting when an
 * operator asks.
 *
 * Kept in days as well, for the route descriptions that publish it, so the
 * contract cannot drift from the code.
 */
export const HOUSEHOLD_RESTORE_WINDOW_DAYS = 30;

export const HOUSEHOLD_RESTORE_WINDOW_MS = HOUSEHOLD_RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

/**
 * The catalog slug an owner's delete grants each owner, pinned to the one
 * household for {@link HOUSEHOLD_RESTORE_WINDOW_MS}, and that a restore
 * revokes. Held by no role.
 */
export const HOUSEHOLD_RESTORE_PERMISSION_SLUG = 'update:household:restore' satisfies PermissionSlug;

/**
 * Wire-contract cap for `CreateHouseholdDto.clientRequestId` (#210). Mirrors
 * `FEEDBACK_MAX_CLIENT_REQUEST_ID_LENGTH`: generous enough for any client id
 * scheme (the Flutter client sends a cuid2 `localId`), tight enough that the
 * unique index never carries unbounded input.
 */
export const HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH = 128;

/**
 * DB name of the `@@unique([createdById, clientRequestId])` constraint, as
 * mapped in `household.prisma`.
 *
 * NO LONGER A DISCRIMINATOR. `recoverKeyedCreate` used to match this against a
 * P2002's `meta.target`; Prisma 7 with the `PrismaPg` driver adapter reports no
 * usable `target`, so the match never fired and every keyed retry became a 500
 * (found by #257's e2e coverage). Replay now keys off the presence of a row
 * under `(createdById, clientRequestId)`, which is shape-independent.
 *
 * Retained as the name of record for the constraint: the e2e suite asserts that
 * the database does NOT report it, which is the assumption worth pinning, and a
 * rename in `household.prisma` should be visible from TypeScript.
 */
export const HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT = 'household_created_by_client_request_id_unique';

/**
 * DB name of the `@@unique([householdId, userId])` constraint, as mapped in
 * `prisma/models/household/household-member.prisma`.
 *
 * NAME OF RECORD ONLY — nothing compares against it on Postgres. Same status as
 * {@link HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT}, for a related reason.
 *
 * The constraint was named rather than left to Prisma's default so that a P2002
 * could be matched against it exactly. That reasoning was sound and the mechanism
 * was absent: `isDuplicateMembership` compared it against `meta.target`, which
 * `@prisma/client@7.8.0` + `@prisma/adapter-pg` never populates, so the match
 * always failed and a genuine concurrent admission answered 500 instead of the
 * documented 409 — exactly the outcome the naming was meant to prevent, by a
 * different route (#298, found by #257's coverage).
 *
 * FIXED in #298. The discriminator now reads the constraint identity from
 * `meta.driverAdapterError.cause.constraint.fields` via `constraintIdentity` in
 * `@bge/database`, which on this stack reports the raw column pair — see
 * {@link HOUSEHOLD_MEMBER_UNIQUE_COLUMNS}. This name survives only as the
 * database's name of record, so a rename in the schema is visible from
 * TypeScript, and as the spelling MySQL's `constraint.index` would report.
 */
export const HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT = 'household_member_household_user_unique';

/**
 * The raw DB column names behind {@link HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT}, in
 * the spelling `@prisma/adapter-pg` reports under
 * `meta.driverAdapterError.cause.constraint.fields`.
 *
 * MEASURED 2026-08-10 against `@prisma/client@7.8.0` + `@prisma/adapter-pg` on
 * Postgres 17 (#298), and pinned end-to-end in
 * `apps/api-e2e/src/database/p2002-shape.spec.ts`. Both package versions are named
 * because the claim is version-specific: the field is not public API, and Prisma
 * intends to restore `meta.target`.
 *
 * This is the spelling that actually matches today. It is compared as an unordered
 * EXACT set, so reordering the `@@unique([...])` declaration cannot change the
 * status code and a future third column cannot be mistaken for this constraint.
 */
export const HOUSEHOLD_MEMBER_UNIQUE_COLUMNS = ['household_id', 'user_id'] as const;

/**
 * The Prisma FIELD names behind {@link HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT}.
 *
 * Not reported by anything on this stack today. Accepted alongside
 * {@link HOUSEHOLD_MEMBER_UNIQUE_COLUMNS} because a restored `meta.target` would
 * use this spelling (prisma/prisma#28953), and `constraintIdentity` reads `target`
 * as a FALLBACK when the driver payload names no constraint. Without this entry,
 * Prisma fixing its own bug would silently demote every real conflict to the
 * `unknown` fallback.
 *
 * A fallback rather than a preference on purpose: the driver payload is parsed from
 * Postgres's own `DETAIL` line and cannot name the wrong table, whereas a restored
 * `target` has no guarantee of arriving free of the nested-create defect that
 * already makes `meta.modelName` unusable (prisma/prisma#29595, #302). Accuracy
 * outranks public-API status for a discriminator.
 */
export const HOUSEHOLD_MEMBER_UNIQUE_FIELDS = ['householdId', 'userId'] as const;
