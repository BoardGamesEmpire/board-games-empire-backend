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
 * `household-member.prisma`. Discriminates a P2002 raised by a concurrent
 * admission of the same user from one raised by any other unique the nested
 * member/role create can touch — today either generated primary key, tomorrow
 * whatever unique someone adds.
 *
 * Named rather than left to Prisma's default so the check is exact. That reasoning
 * still holds, but it was never the binding constraint: `isDuplicateMembership`
 * compares this against `meta.target`, and `@prisma/client@7.8.0` +
 * `@prisma/adapter-pg` never populates `target` — `meta` carries only
 * `driverAdapterError`. So the match has always failed and a genuine duplicate
 * admission answers 500 rather than the documented 409, exactly the outcome the
 * naming was meant to prevent, for a different reason (#298).
 *
 * The fix reads `meta.driverAdapterError.cause.constraint.fields`, which the pg
 * adapter populates with the raw column pair `['household_id', 'user_id']` — so
 * this constant stays the name of record, and the column pair becomes the value
 * actually compared. Measured in `household-idempotency.spec.ts` (#257); shared
 * normalizer is #292.
 */
export const HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT = 'household_member_household_user_unique';
