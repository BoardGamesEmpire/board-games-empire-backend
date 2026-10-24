-- #810: game shares, and the household setting that decides which of a
-- member's shares take effect.
--
-- `GameSharing` was a resource type with no model behind it. It is `GameShare`
-- now, the model this migration adds. Written by hand as a rename: left to
-- itself, Prisma recreates the type and casts every column that uses it
-- (`resource_type` on `api_key_scopes`, `user_permissions` and
-- `webhook_subscriptions`, and `subject_type` on `media_contributions`). A
-- rename changes only the label, so no column is touched, and the schema and
-- migrations still show no difference.
--
-- `member_share_policy` needs no backfill beyond its default: every household
-- already has a settings row, and a member's share waits for an owner or admin
-- to approve it.

-- CreateEnum
CREATE TYPE "member_share_policies" AS ENUM ('Off', 'NeedsApproval', 'Direct');

-- AlterEnum
ALTER TYPE "resource_types" RENAME VALUE 'GameSharing' TO 'GameShare';

-- AlterTable
ALTER TABLE "household_settings" ADD COLUMN     "member_share_policy" "member_share_policies" NOT NULL DEFAULT 'NeedsApproval';

-- CreateTable
CREATE TABLE "game_shares" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "user_id" TEXT,
    "household_id" TEXT,
    "shared_by_id" TEXT,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_shares_user_id_idx" ON "game_shares"("user_id");

-- CreateIndex
CREATE INDEX "game_shares_household_id_idx" ON "game_shares"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_shares_game_id_user_id_key" ON "game_shares"("game_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_shares_game_id_household_id_key" ON "game_shares"("game_id", "household_id");

-- AddForeignKey
ALTER TABLE "game_shares" ADD CONSTRAINT "game_shares_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_shares" ADD CONSTRAINT "game_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_shares" ADD CONSTRAINT "game_shares_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_shares" ADD CONSTRAINT "game_shares_shared_by_id_fkey" FOREIGN KEY ("shared_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_shares" ADD CONSTRAINT "game_shares_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CheckConstraint
-- Prisma cannot express CHECK constraints in the schema, so it is written
-- here: a share names exactly one recipient (#810).
ALTER TABLE "game_shares"
  ADD CONSTRAINT "game_shares_one_recipient" CHECK (num_nonnulls("user_id", "household_id") = 1);
