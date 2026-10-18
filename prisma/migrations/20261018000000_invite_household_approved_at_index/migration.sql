-- #166: at Household scope the daily invite cap counts a member's invite that
-- waited from when it was approved, so the household count reads approvals in
-- the last 24 hours beside creations.

-- CreateIndex
CREATE INDEX "invites_household_id_approved_at_idx" ON "invites"("household_id", "approved_at");
