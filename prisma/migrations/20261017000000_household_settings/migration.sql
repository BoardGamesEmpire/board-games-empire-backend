-- #166: a household's own settings, starting with whether its member role may
-- invite. Every household gets a row, so the existing ones are filled in with
-- the default: a member's invite waits for an owner or admin to approve it.

-- CreateEnum
CREATE TYPE "member_invite_policies" AS ENUM ('Off', 'NeedsApproval', 'Direct');

-- CreateTable
CREATE TABLE "household_settings" (
    "household_id" TEXT NOT NULL,
    "member_invite_policy" "member_invite_policies" NOT NULL DEFAULT 'NeedsApproval',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "household_settings_pkey" PRIMARY KEY ("household_id")
);

-- AddForeignKey
ALTER TABLE "household_settings" ADD CONSTRAINT "household_settings_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one row per household, soft-deleted ones included, since a
-- restore brings a household back with its settings.
INSERT INTO "household_settings" ("household_id", "updated_at")
SELECT "id", CURRENT_TIMESTAMP FROM "households";
