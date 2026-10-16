-- #551: removing an attendee, or a game from their list, keeps the row and
-- stamps it. A nomination whose supplier is out of the event pauses, and
-- remembers the status it returns to.

-- AlterEnum
ALTER TYPE "nomination_statuses" ADD VALUE 'Paused';

-- AlterTable
ALTER TABLE "event_attendees" ADD COLUMN "removed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "attendee_game_lists" ADD COLUMN "removed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "event_game_nominations" ADD COLUMN "paused_from" "nomination_statuses";
