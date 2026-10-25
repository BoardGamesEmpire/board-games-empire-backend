-- #252: POST /events takes a client request id, as POST /households (#210)
-- and POST /feedback/reports (#251) do. A retried create finds the event its
-- first attempt made under (created_by_id, client_request_id) instead of
-- making a second one. Per creator, never global; NULLs are distinct, so
-- unkeyed events are unaffected.

-- AlterTable
ALTER TABLE "events" ADD COLUMN "client_request_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "event_created_by_client_request_id_unique" ON "events"("created_by_id", "client_request_id");
