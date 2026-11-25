-- #742: an event's invite list filters by event and reads newest first, as
-- the household's list reads `invites_household_id_created_at_idx`.

-- CreateIndex
CREATE INDEX "invites_event_id_created_at_idx" ON "invites"("event_id", "created_at");
