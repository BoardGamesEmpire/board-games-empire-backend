-- #512: index `event_attendees` by user.
--
-- `GET /events` now scopes to the events the caller is an attendee of,
-- `attendees: { some: { userId } }`, which looks up `event_attendees` by
-- `user_id` alone. Neither existing index leads on it: the unique is
-- `(event_id, user_id)` and the plain index is `(event_id)`. Without this one
-- the scope is a sequential scan of the whole table for every caller.
--
-- The ceiling's `read:event:participant` terms filter by user too, but each
-- also binds the event id, so the unique already serves them.

-- CreateIndex
CREATE INDEX "event_attendees_user_id_idx" ON "event_attendees"("user_id");
