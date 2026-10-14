-- #278: who may be invited to a household on this server, as a level of the
-- `Visibility` ladder. `Public` lets invites through as before.

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN "household_invitee_policy" "visibility_types" NOT NULL DEFAULT 'Public';
