-- Refuse a second outstanding invite to the same person for the same context.
--
-- Hand-written: Prisma cannot model a partial index, so these four are
-- deliberately absent from `prisma/models/system/invite.prisma`, on the
-- precedent of `unique_primary_category_per_game` in
-- 20260219032812_games_events_household_profile. The lib that writes invites
-- (`@bge/invites`) maps the resulting P2002 to 409 by the raw column pair the
-- driver adapter reports, and `apps/api-e2e/src/invite` pins both the index
-- set and that reporting against a real database.
--
-- Only Pending and AwaitingApproval rows are inside the constraint. A settled
-- row — accepted, declined, revoked, withdrawn or expired — sits outside it, so a
-- re-invite after any of those is a new row with a new token rather than a
-- repurposed one.
--
-- NULLs are distinct under a unique index, so an email-only invite (no
-- `invitee_id`) collides on the email pair and a user-bound invite collides
-- on the id pair; neither blocks the other. The email column is compared as
-- stored: `@bge/invites` trims and lower-cases it before every insert.

-- CreateIndex
CREATE UNIQUE INDEX "invites_household_invitee_outstanding_unique" ON "invites" ("household_id", "invitee_id") WHERE "status" IN ('Pending', 'AwaitingApproval');

-- CreateIndex
CREATE UNIQUE INDEX "invites_household_invitee_email_outstanding_unique" ON "invites" ("household_id", "invitee_email") WHERE "status" IN ('Pending', 'AwaitingApproval');

-- CreateIndex
CREATE UNIQUE INDEX "invites_event_invitee_outstanding_unique" ON "invites" ("event_id", "invitee_id") WHERE "status" IN ('Pending', 'AwaitingApproval');

-- CreateIndex
CREATE UNIQUE INDEX "invites_event_invitee_email_outstanding_unique" ON "invites" ("event_id", "invitee_email") WHERE "status" IN ('Pending', 'AwaitingApproval');
