/*
  Warnings:

  - You are about to drop the column `user_id` on the `event_availability_votes` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `event_game_votes` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[occurrence_id,attendee_id]` on the table `event_availability_votes` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[event_game_nomination_id,attendee_id]` on the table `event_game_votes` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `attendee_id` to the `event_availability_votes` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `event_game_nominations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `attendee_id` to the `event_game_votes` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "notification_types" ADD VALUE 'HouseholdInviteReceived';
ALTER TYPE "notification_types" ADD VALUE 'EventInviteReceived';
ALTER TYPE "notification_types" ADD VALUE 'EventOccurrenceProposed';
ALTER TYPE "notification_types" ADD VALUE 'EventOccurrenceConfirmed';
ALTER TYPE "notification_types" ADD VALUE 'EventOccurrenceCanceled';
ALTER TYPE "notification_types" ADD VALUE 'EventOccurrenceDeclined';
ALTER TYPE "notification_types" ADD VALUE 'EventOccurrenceRescheduled';
ALTER TYPE "notification_types" ADD VALUE 'EventRsvpReceived';
ALTER TYPE "notification_types" ADD VALUE 'EventCreated';
ALTER TYPE "notification_types" ADD VALUE 'GameNominated';
ALTER TYPE "notification_types" ADD VALUE 'GameNominationApproved';
ALTER TYPE "notification_types" ADD VALUE 'GameNominationRejected';
ALTER TYPE "notification_types" ADD VALUE 'GameNominationFailed';
ALTER TYPE "notification_types" ADD VALUE 'GameNominationPassed';
ALTER TYPE "notification_types" ADD VALUE 'GameAddedToEvent';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "resource_types" ADD VALUE 'Media';
ALTER TYPE "resource_types" ADD VALUE 'GamePlayResult';
ALTER TYPE "resource_types" ADD VALUE 'SessionPlayer';
ALTER TYPE "resource_types" ADD VALUE 'HouseholdMember';
ALTER TYPE "resource_types" ADD VALUE 'HouseholdRole';
ALTER TYPE "resource_types" ADD VALUE 'Invite';
ALTER TYPE "resource_types" ADD VALUE 'EventAttendee';
ALTER TYPE "resource_types" ADD VALUE 'EventAttendeeGameList';
ALTER TYPE "resource_types" ADD VALUE 'EventAvailabilityVote';
ALTER TYPE "resource_types" ADD VALUE 'EventGame';
ALTER TYPE "resource_types" ADD VALUE 'EventGameNomination';
ALTER TYPE "resource_types" ADD VALUE 'EventGameVote';
ALTER TYPE "resource_types" ADD VALUE 'EventOccurrence';
ALTER TYPE "resource_types" ADD VALUE 'EventPolicy';

-- DropForeignKey
ALTER TABLE "event_availability_votes" DROP CONSTRAINT "event_availability_votes_user_id_fkey";

-- DropForeignKey
ALTER TABLE "event_game_votes" DROP CONSTRAINT "event_game_votes_user_id_fkey";

-- DropIndex
DROP INDEX "event_availability_votes_occurrence_id_user_id_key";

-- DropIndex
DROP INDEX "event_availability_votes_user_id_idx";

-- DropIndex
DROP INDEX "event_game_votes_event_game_nomination_id_user_id_key";

-- DropIndex
DROP INDEX "event_game_votes_user_id_idx";

-- AlterTable
ALTER TABLE "event_availability_votes" DROP COLUMN "user_id",
ADD COLUMN     "attendee_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "event_game_nominations" ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL;

-- AlterTable
ALTER TABLE "event_game_votes" DROP COLUMN "user_id",
ADD COLUMN     "attendee_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "events" ALTER COLUMN "household_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "event_availability_votes_attendee_id_idx" ON "event_availability_votes"("attendee_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_availability_votes_occurrence_id_attendee_id_key" ON "event_availability_votes"("occurrence_id", "attendee_id");

-- CreateIndex
CREATE INDEX "event_game_votes_attendee_id_idx" ON "event_game_votes"("attendee_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_game_votes_event_game_nomination_id_attendee_id_key" ON "event_game_votes"("event_game_nomination_id", "attendee_id");

-- AddForeignKey
ALTER TABLE "event_availability_votes" ADD CONSTRAINT "event_availability_votes_attendee_id_fkey" FOREIGN KEY ("attendee_id") REFERENCES "event_attendees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_votes" ADD CONSTRAINT "event_game_votes_attendee_id_fkey" FOREIGN KEY ("attendee_id") REFERENCES "event_attendees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
