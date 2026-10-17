-- #546: who may be placed on an event by id, as a level of the `Visibility`
-- ladder: the server's policy and each user's own preference, apart from the
-- household ones. `Public` lets everyone through as before.

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN "event_invitee_policy" "visibility_types" NOT NULL DEFAULT 'Public';

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN "allow_event_invites_from" "visibility_types" NOT NULL DEFAULT 'Public';
