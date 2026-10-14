-- #278: who may invite this user to a household, as a level of the
-- `Visibility` ladder. `Public` lets invites through as before.

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN "allow_household_invites_from" "visibility_types" NOT NULL DEFAULT 'Public';
