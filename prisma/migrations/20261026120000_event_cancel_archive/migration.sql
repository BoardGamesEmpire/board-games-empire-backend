-- #795: an event stores its host's decisions, not a status. Cancel and archive
-- become timestamps beside the existing cancelled_by_id and cancel_reason, and
-- the status a response carries is worked out on read from them and the
-- event's confirmed dates. Nothing is deployed, so the stored status is
-- dropped with no backfill. Postgres can add an enum value inside the
-- migration's transaction, but can't use it there, and nothing here does.

-- AlterTable
ALTER TABLE "events" ADD COLUMN "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN "archived_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "events" DROP COLUMN "status";

-- DropEnum
DROP TYPE "event_statuses";

-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'EventCancelled';

-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'EventReopened';
