-- #276: household membership provenance.
--
-- `origin` records which consent path produced the row and `added_by_id` who
-- acted on the household's side. Both are nullable: rows created outside any
-- consent path (e2e roster fixtures, future data imports) genuinely have no
-- origin, and NULL means exactly that.
--
-- No backfill. Pre-alpha with no live deployments — the database is reset and
-- re-seeded rather than migrated forward, so pre-existing rows are not worth
-- attributing. Revisit once there is data anyone would miss.

-- CreateEnum
CREATE TYPE "household_membership_origins" AS ENUM ('Founder', 'InviteAccepted', 'JoinApproved');

-- AlterTable
ALTER TABLE "household_members"
  ADD COLUMN "origin" "household_membership_origins",
  ADD COLUMN "added_by_id" TEXT;

-- CreateIndex
CREATE INDEX "household_members_added_by_id_idx" ON "household_members"("added_by_id");

-- AddForeignKey
ALTER TABLE "household_members"
  ADD CONSTRAINT "household_members_added_by_id_fkey"
  FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
