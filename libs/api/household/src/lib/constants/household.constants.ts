/**
 * Wire-contract cap for `CreateHouseholdDto.clientRequestId` (#210). Mirrors
 * `FEEDBACK_MAX_CLIENT_REQUEST_ID_LENGTH`: generous enough for any client id
 * scheme (the Flutter client sends a cuid2 `localId`), tight enough that the
 * unique index never carries unbounded input.
 */
export const HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH = 128;

/**
 * DB name of the `@@unique([createdById, clientRequestId])` constraint, as
 * mapped in `household.prisma`. Used to discriminate a P2002 raised by an
 * idempotent replay from a P2002 raised by any other unique on the same nested
 * create.
 */
export const HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT = 'household_created_by_client_request_id_unique';

/**
 * DB name of the `@@unique([householdId, userId])` constraint, as mapped in
 * `household-member.prisma`. Used to discriminate a P2002 raised by a concurrent
 * admission of the same user from a P2002 raised by any other unique the nested
 * member/role create can touch — today either generated primary key, tomorrow
 * whatever unique someone adds.
 *
 * Named rather than left to Prisma's default so the check is exact. Guessing the
 * generated name would be the dangerous option: get it wrong and a genuine
 * duplicate stops being recognised, turning the documented 409 into a 500 on the
 * common path.
 */
export const HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT = 'household_member_household_user_unique';
