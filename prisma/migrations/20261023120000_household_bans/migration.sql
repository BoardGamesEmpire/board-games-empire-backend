-- #782: household bans. A household's owners and admins bar a user from it, and
-- each ban is one row, under a new resource type its four permissions name.

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'HouseholdBan';

-- CreateTable
CREATE TABLE "household_bans" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "banned_by_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "household_bans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "household_bans_user_id_idx" ON "household_bans"("user_id");

-- CreateIndex
CREATE INDEX "household_bans_banned_by_id_idx" ON "household_bans"("banned_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "household_ban_household_user_unique" ON "household_bans"("household_id", "user_id");

-- AddForeignKey
ALTER TABLE "household_bans" ADD CONSTRAINT "household_bans_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_bans" ADD CONSTRAINT "household_bans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_bans" ADD CONSTRAINT "household_bans_banned_by_id_fkey" FOREIGN KEY ("banned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
