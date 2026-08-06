/**
 * Wire-contract cap for `CreateHouseholdDto.clientRequestId` (#210). Mirrors
 * `FEEDBACK_MAX_CORRELATION_KEY_LENGTH`: generous enough for any client id
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
