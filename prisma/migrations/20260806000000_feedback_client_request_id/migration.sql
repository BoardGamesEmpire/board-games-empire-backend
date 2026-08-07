-- Converge the feedback idempotency key on the `clientRequestId` name that
-- `Household.clientRequestId` shipped in #210. `correlationKey` was not merely
-- inconsistent with it: this codebase already uses `correlationId` pervasively
-- for request tracing (audit log, the HTTP/gRPC/WS actor interceptors, domain
-- event payloads), so `correlationKey` read as a false cognate for that concept
-- rather than as an idempotency token. See #251.
--
-- Hand-written as a RENAME. `prisma migrate diff` would emit DROP COLUMN +
-- ADD COLUMN for a field rename and silently discard every persisted key.
ALTER TABLE "feedback_reports" RENAME COLUMN "correlation_key" TO "client_request_id";

-- The uniqueness is enforced by a unique *index* (created with CREATE UNIQUE
-- INDEX in 20260606011551_feedback), not a table constraint, so ALTER INDEX is
-- the matching rename verb. The name is mirrored in
-- `FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT`, which the P2002 discriminator reads —
-- the two must not drift.
ALTER INDEX "feedback_report_user_correlation_key_unique" RENAME TO "feedback_report_user_client_request_id_unique";
