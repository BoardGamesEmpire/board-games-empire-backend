-- #279: the daily household invite cap counts the invites created in the last
-- 24 hours, by inviter and by household. The household's newest-first invite
-- list (#162) reads the second index backward.

-- CreateIndex
CREATE INDEX "invites_inviter_id_created_at_idx" ON "invites"("inviter_id", "created_at");

-- CreateIndex
CREATE INDEX "invites_household_id_created_at_idx" ON "invites"("household_id", "created_at");
