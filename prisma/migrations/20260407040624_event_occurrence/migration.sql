/*
  Warnings:

  - You are about to drop the column `event_game_id` on the `event_game_votes` table. All the data in the column will be lost.
  - You are about to drop the column `event_id` on the `event_game_votes` table. All the data in the column will be lost.
  - You are about to drop the column `suggested_by_id` on the `event_games` table. All the data in the column will be lost.
  - You are about to drop the column `end_date` on the `events` table. All the data in the column will be lost.
  - You are about to drop the column `start_date` on the `events` table. All the data in the column will be lost.
  - You are about to drop the column `event_id` on the `game_play_sessions` table. All the data in the column will be lost.
  - You are about to drop the column `is_complete` on the `game_play_sessions` table. All the data in the column will be lost.
  - You are about to drop the column `was_interrupted` on the `game_play_sessions` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[event_game_nomination_id,user_id]` on the table `event_game_votes` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[nomination_id]` on the table `event_games` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[continued_from_id]` on the table `game_play_sessions` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `event_game_nomination_id` to the `event_game_votes` table without a default value. This is not possible if the table is not empty.
  - Added the required column `supplied_by_id` to the `event_games` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `event_games` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "availability_responses" AS ENUM ('Available', 'Maybe', 'Unavailable');

-- CreateEnum
CREATE TYPE "game_addition_modes" AS ENUM ('Direct', 'RequiresVote', 'HostApproval', 'HostOnly');

-- CreateEnum
CREATE TYPE "nomination_statuses" AS ENUM ('Open', 'AwaitingApproval', 'Approved', 'Passed', 'Failed', 'QuorumNotMet', 'Rejected', 'Withdrawn');

-- CreateEnum
CREATE TYPE "vote_threshold_types" AS ENUM ('SimpleMajority', 'Supermajority', 'Unanimous', 'FixedCount');

-- CreateEnum
CREATE TYPE "vote_quorum_types" AS ENUM ('None', 'PercentOfAttendees', 'FixedCount');

-- CreateEnum
CREATE TYPE "vote_eligibilities" AS ENUM ('AllAttendees', 'ConfirmedOnly', 'PoolParticipants');

-- CreateEnum
CREATE TYPE "interested_weights" AS ENUM ('AsFor', 'AsAbstain', 'AsAgainst');

-- CreateEnum
CREATE TYPE "scheduled_game_roles" AS ENUM ('Primary', 'Filler');

-- CreateEnum
CREATE TYPE "occurrence_statuses" AS ENUM ('Proposed', 'Confirmed', 'Declined', 'Cancelled');

-- CreateEnum
CREATE TYPE "recurrence_frequencies" AS ENUM ('Weekly', 'BiWeekly', 'Monthly');

-- CreateEnum
CREATE TYPE "recurrence_instance_statuses" AS ENUM ('PendingApproval', 'Approved', 'Rejected');

-- CreateEnum
CREATE TYPE "event_scheduling_modes" AS ENUM ('Fixed', 'Poll', 'MultiDay');

-- CreateEnum
CREATE TYPE "game_play_session_statuses" AS ENUM ('InProgress', 'Paused', 'Completed', 'Abandoned');

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'Notification';

-- DropForeignKey
ALTER TABLE "event_game_votes" DROP CONSTRAINT "event_game_votes_event_game_id_fkey";

-- DropForeignKey
ALTER TABLE "event_game_votes" DROP CONSTRAINT "event_game_votes_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_games" DROP CONSTRAINT "event_games_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_games" DROP CONSTRAINT "event_games_suggested_by_id_fkey";

-- DropForeignKey
ALTER TABLE "game_play_sessions" DROP CONSTRAINT "game_play_sessions_event_id_fkey";

-- DropIndex
DROP INDEX "event_game_votes_event_game_id_user_id_key";

-- DropIndex
DROP INDEX "events_start_date_idx";

-- DropIndex
DROP INDEX "game_play_sessions_event_id_idx";

-- AlterTable
ALTER TABLE "event_game_votes" DROP COLUMN "event_game_id",
DROP COLUMN "event_id",
ADD COLUMN     "event_game_nomination_id" TEXT NOT NULL,
ADD COLUMN     "occurrence_id" TEXT;

-- AlterTable
ALTER TABLE "event_games" DROP COLUMN "suggested_by_id",
ADD COLUMN     "added_by_id" TEXT,
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "max_play_time" INTEGER,
ADD COLUMN     "nomination_id" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "occurrence_id" TEXT,
ADD COLUMN     "role" "scheduled_game_roles" NOT NULL DEFAULT 'Primary',
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "supplied_by_id" TEXT NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL,
ALTER COLUMN "event_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "event_policies" ADD COLUMN     "filler_max_play_time" INTEGER,
ADD COLUMN     "game_addition_mode" "game_addition_modes" NOT NULL DEFAULT 'Direct',
ADD COLUMN     "interested_weight" "interested_weights" NOT NULL DEFAULT 'AsAbstain',
ADD COLUMN     "restrict_to_attendee_pool" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "vote_eligibility" "vote_eligibilities" NOT NULL DEFAULT 'ConfirmedOnly',
ADD COLUMN     "vote_quorum_type" "vote_quorum_types" NOT NULL DEFAULT 'None',
ADD COLUMN     "vote_quorum_value" INTEGER,
ADD COLUMN     "vote_threshold_type" "vote_threshold_types" NOT NULL DEFAULT 'SimpleMajority',
ADD COLUMN     "vote_threshold_value" INTEGER,
ADD COLUMN     "voting_window_hours" INTEGER;

-- AlterTable
ALTER TABLE "events" DROP COLUMN "end_date",
DROP COLUMN "start_date",
ADD COLUMN     "recurrence_rule_id" TEXT,
ADD COLUMN     "recurrence_status" "recurrence_instance_statuses",
ADD COLUMN     "scheduling_mode" "event_scheduling_modes" NOT NULL DEFAULT 'Fixed';

-- AlterTable
ALTER TABLE "game_play_sessions" DROP COLUMN "event_id",
DROP COLUMN "is_complete",
DROP COLUMN "was_interrupted",
ADD COLUMN     "continued_from_id" TEXT,
ADD COLUMN     "occurrence_id" TEXT,
ADD COLUMN     "paused_at" TIMESTAMPTZ(3),
ADD COLUMN     "resumed_at" TIMESTAMPTZ(3),
ADD COLUMN     "status" "game_play_session_statuses" NOT NULL DEFAULT 'InProgress';

-- CreateTable
CREATE TABLE "event_availability_votes" (
    "id" TEXT NOT NULL,
    "occurrence_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "response" "availability_responses" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_availability_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_game_nominations" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "occurrence_id" TEXT,
    "game_id" TEXT NOT NULL,
    "voting_deadline" TIMESTAMPTZ(3),
    "nominated_by_id" TEXT NOT NULL,
    "supplied_from_id" TEXT NOT NULL,
    "status" "nomination_statuses" NOT NULL DEFAULT 'Open',

    CONSTRAINT "event_game_nominations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_occurrence_policies" (
    "id" TEXT NOT NULL,
    "occurrence_id" TEXT NOT NULL,
    "restrict_to_game_categories" BOOLEAN,
    "max_attendees" INTEGER,
    "max_total_participants" INTEGER,
    "strict_capacity" BOOLEAN,
    "require_host_approval" BOOLEAN,
    "allow_spectators" BOOLEAN,
    "game_addition_mode" "game_addition_modes",
    "restrict_to_attendee_pool" BOOLEAN,
    "filler_max_play_time" INTEGER,
    "vote_threshold_type" "vote_threshold_types",
    "vote_threshold_value" INTEGER,
    "vote_quorum_type" "vote_quorum_types",
    "vote_quorum_value" INTEGER,
    "vote_eligibility" "vote_eligibilities",
    "interested_weight" "interested_weights",
    "voting_window_hours" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_occurrence_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occurrence_categories" (
    "id" TEXT NOT NULL,
    "occurrence_policy_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "occurrence_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_occurrences" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "label" TEXT,
    "start_date" TIMESTAMPTZ(3),
    "end_date" TIMESTAMPTZ(3),
    "location" TEXT,
    "status" "occurrence_statuses" NOT NULL DEFAULT 'Confirmed',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "confirmed_at" TIMESTAMPTZ(3),
    "declined_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_recurrence_rules" (
    "id" TEXT NOT NULL,
    "template_event_id" TEXT NOT NULL,
    "frequency" "recurrence_frequencies" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "day_of_week" INTEGER,
    "week_of_month" INTEGER,
    "start_time" TEXT NOT NULL,
    "default_duration" INTEGER,
    "requires_host_approval" BOOLEAN NOT NULL DEFAULT true,
    "notify_attendees_on_schedule" BOOLEAN NOT NULL DEFAULT true,
    "notify_attendees_on_rejection" BOOLEAN NOT NULL DEFAULT true,
    "generates_in_advance_days" INTEGER NOT NULL DEFAULT 14,
    "ends_at" TIMESTAMPTZ(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_recurrence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_availability_votes_user_id_idx" ON "event_availability_votes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_availability_votes_occurrence_id_user_id_key" ON "event_availability_votes"("occurrence_id", "user_id");

-- CreateIndex
CREATE INDEX "event_game_nominations_event_id_idx" ON "event_game_nominations"("event_id");

-- CreateIndex
CREATE INDEX "event_game_nominations_occurrence_id_idx" ON "event_game_nominations"("occurrence_id");

-- CreateIndex
CREATE INDEX "event_game_nominations_supplied_from_id_idx" ON "event_game_nominations"("supplied_from_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_occurrence_policies_occurrence_id_key" ON "event_occurrence_policies"("occurrence_id");

-- CreateIndex
CREATE UNIQUE INDEX "occurrence_categories_occurrence_policy_id_category_id_key" ON "occurrence_categories"("occurrence_policy_id", "category_id");

-- CreateIndex
CREATE INDEX "event_occurrences_event_id_idx" ON "event_occurrences"("event_id");

-- CreateIndex
CREATE INDEX "event_occurrences_event_id_status_idx" ON "event_occurrences"("event_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "event_game_votes_event_game_nomination_id_user_id_key" ON "event_game_votes"("event_game_nomination_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_games_nomination_id_key" ON "event_games"("nomination_id");

-- CreateIndex
CREATE INDEX "event_games_event_id_idx" ON "event_games"("event_id");

-- CreateIndex
CREATE INDEX "event_games_occurrence_id_idx" ON "event_games"("occurrence_id");

-- CreateIndex
CREATE INDEX "event_games_event_id_role_idx" ON "event_games"("event_id", "role");

-- CreateIndex
CREATE INDEX "event_games_occurrence_id_role_idx" ON "event_games"("occurrence_id", "role");

-- CreateIndex
CREATE INDEX "event_games_supplied_by_id_idx" ON "event_games"("supplied_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_play_sessions_continued_from_id_key" ON "game_play_sessions"("continued_from_id");

-- CreateIndex
CREATE INDEX "game_play_sessions_occurrence_id_idx" ON "game_play_sessions"("occurrence_id");

-- AddForeignKey
ALTER TABLE "event_availability_votes" ADD CONSTRAINT "event_availability_votes_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_availability_votes" ADD CONSTRAINT "event_availability_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_nominations" ADD CONSTRAINT "event_game_nominations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_nominations" ADD CONSTRAINT "event_game_nominations_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_nominations" ADD CONSTRAINT "event_game_nominations_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_nominations" ADD CONSTRAINT "event_game_nominations_nominated_by_id_fkey" FOREIGN KEY ("nominated_by_id") REFERENCES "event_attendees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_nominations" ADD CONSTRAINT "event_game_nominations_supplied_from_id_fkey" FOREIGN KEY ("supplied_from_id") REFERENCES "attendee_game_lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_votes" ADD CONSTRAINT "event_game_votes_event_game_nomination_id_fkey" FOREIGN KEY ("event_game_nomination_id") REFERENCES "event_game_nominations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_votes" ADD CONSTRAINT "event_game_votes_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_supplied_by_id_fkey" FOREIGN KEY ("supplied_by_id") REFERENCES "attendee_game_lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_nomination_id_fkey" FOREIGN KEY ("nomination_id") REFERENCES "event_game_nominations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "event_attendees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_occurrence_policies" ADD CONSTRAINT "event_occurrence_policies_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence_categories" ADD CONSTRAINT "occurrence_categories_occurrence_policy_id_fkey" FOREIGN KEY ("occurrence_policy_id") REFERENCES "event_occurrence_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence_categories" ADD CONSTRAINT "occurrence_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_occurrences" ADD CONSTRAINT "event_occurrences_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_recurrence_rules" ADD CONSTRAINT "event_recurrence_rules_template_event_id_fkey" FOREIGN KEY ("template_event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_recurrence_rule_id_fkey" FOREIGN KEY ("recurrence_rule_id") REFERENCES "event_recurrence_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_continued_from_id_fkey" FOREIGN KEY ("continued_from_id") REFERENCES "game_play_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
