-- #276 review: name the household membership unique.
--
-- `@@unique([householdId, userId])` was unnamed, so Postgres carried Prisma's
-- generated name. `addMemberWithin` needs to tell a P2002 raised by a concurrent
-- admission of the same user from one raised by any other unique the nested
-- member/role create can touch, and matching on a guessed generated name is the
-- dangerous option: get it wrong and a genuine duplicate stops being recognised,
-- turning the documented 409 into a 500 on the common path.
--
-- Mirrors `household_created_by_client_request_id_unique` on `households`.

ALTER INDEX "household_members_household_id_user_id_key"
  RENAME TO "household_member_household_user_unique";
