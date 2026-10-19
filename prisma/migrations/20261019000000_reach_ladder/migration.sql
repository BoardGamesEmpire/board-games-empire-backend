-- #808: the reach ladder. `Visibility` is `Reach` now, the name the glossary
-- gives it, and each `visibility` column is `reach`. The other five columns
-- typed on the enum keep their names and take the new type.
--
-- `Household` leaves the ladder. Postgres cannot drop a value from an enum, so
-- the columns move to a new type, every `Household` becoming `Private` as it
-- is cast. On households and events that keeps today's behaviour: no rule
-- reads `Household` on either one, and membership grants a household's own
-- access. A collection's household sees it whatever its reach now (#495), so
-- a `Household` entry keeps its household readers as `Private`. That rule
-- change, not this cast, also opens every `Private` entry, the column
-- default, to the owner's households, unless the owner turns collection
-- sharing off or excludes the entry. Media cannot hold `Household`, and the
-- routes never let the five settings columns take it, so the cast only guards
-- a write that skipped them.
--
-- Written by hand: left to itself, Prisma drops each `visibility` column and
-- adds `reach`, losing every row's value.

-- CreateEnum
CREATE TYPE "reach_types" AS ENUM ('Friends', 'FriendsOfFriends', 'Private', 'Public');

-- events
ALTER TABLE "events" RENAME COLUMN "visibility" TO "reach";
ALTER TABLE "events"
  ALTER COLUMN "reach" DROP DEFAULT,
  ALTER COLUMN "reach" TYPE "reach_types"
    USING (CASE WHEN "reach" = 'Household' THEN 'Private' ELSE "reach"::text END)::"reach_types",
  ALTER COLUMN "reach" SET DEFAULT 'Friends';

-- games
ALTER TABLE "games" RENAME COLUMN "visibility" TO "reach";
ALTER TABLE "games"
  ALTER COLUMN "reach" DROP DEFAULT,
  ALTER COLUMN "reach" TYPE "reach_types"
    USING (CASE WHEN "reach" = 'Household' THEN 'Private' ELSE "reach"::text END)::"reach_types",
  ALTER COLUMN "reach" SET DEFAULT 'Public';

-- game_collections
ALTER TABLE "game_collections" RENAME COLUMN "visibility" TO "reach";
ALTER TABLE "game_collections"
  ALTER COLUMN "reach" DROP DEFAULT,
  ALTER COLUMN "reach" TYPE "reach_types"
    USING (CASE WHEN "reach" = 'Household' THEN 'Private' ELSE "reach"::text END)::"reach_types",
  ALTER COLUMN "reach" SET DEFAULT 'Private';

-- households: the default was `Household`, which is members only.
ALTER TABLE "households" RENAME COLUMN "visibility" TO "reach";
ALTER TABLE "households"
  ALTER COLUMN "reach" DROP DEFAULT,
  ALTER COLUMN "reach" TYPE "reach_types"
    USING (CASE WHEN "reach" = 'Household' THEN 'Private' ELSE "reach"::text END)::"reach_types",
  ALTER COLUMN "reach" SET DEFAULT 'Private';

-- media_objects
ALTER TABLE "media_objects" RENAME COLUMN "visibility" TO "reach";
ALTER TABLE "media_objects"
  ALTER COLUMN "reach" DROP DEFAULT,
  ALTER COLUMN "reach" TYPE "reach_types"
    USING (CASE WHEN "reach" = 'Household' THEN 'Private' ELSE "reach"::text END)::"reach_types",
  ALTER COLUMN "reach" SET DEFAULT 'Private';

-- user_profiles
ALTER TABLE "user_profiles" RENAME COLUMN "visibility" TO "reach";
ALTER TABLE "user_profiles"
  ALTER COLUMN "reach" DROP DEFAULT,
  ALTER COLUMN "reach" TYPE "reach_types"
    USING (CASE WHEN "reach" = 'Household' THEN 'Private' ELSE "reach"::text END)::"reach_types",
  ALTER COLUMN "reach" SET DEFAULT 'Public';

-- system_settings: the invitee policies keep their names.
ALTER TABLE "system_settings"
  ALTER COLUMN "household_invitee_policy" DROP DEFAULT,
  ALTER COLUMN "household_invitee_policy" TYPE "reach_types"
    USING (CASE WHEN "household_invitee_policy" = 'Household' THEN 'Private' ELSE "household_invitee_policy"::text END)::"reach_types",
  ALTER COLUMN "household_invitee_policy" SET DEFAULT 'Public',
  ALTER COLUMN "event_invitee_policy" DROP DEFAULT,
  ALTER COLUMN "event_invitee_policy" TYPE "reach_types"
    USING (CASE WHEN "event_invitee_policy" = 'Household' THEN 'Private' ELSE "event_invitee_policy"::text END)::"reach_types",
  ALTER COLUMN "event_invitee_policy" SET DEFAULT 'Public';

-- user_preferences: the invite preferences and the review default keep their names.
ALTER TABLE "user_preferences"
  ALTER COLUMN "allow_household_invites_from" DROP DEFAULT,
  ALTER COLUMN "allow_household_invites_from" TYPE "reach_types"
    USING (CASE WHEN "allow_household_invites_from" = 'Household' THEN 'Private' ELSE "allow_household_invites_from"::text END)::"reach_types",
  ALTER COLUMN "allow_household_invites_from" SET DEFAULT 'Public',
  ALTER COLUMN "allow_event_invites_from" DROP DEFAULT,
  ALTER COLUMN "allow_event_invites_from" TYPE "reach_types"
    USING (CASE WHEN "allow_event_invites_from" = 'Household' THEN 'Private' ELSE "allow_event_invites_from"::text END)::"reach_types",
  ALTER COLUMN "allow_event_invites_from" SET DEFAULT 'Public',
  ALTER COLUMN "default_review_visibility" DROP DEFAULT,
  ALTER COLUMN "default_review_visibility" TYPE "reach_types"
    USING (CASE WHEN "default_review_visibility" = 'Household' THEN 'Private' ELSE "default_review_visibility"::text END)::"reach_types",
  ALTER COLUMN "default_review_visibility" SET DEFAULT 'Private';

-- DropEnum
DROP TYPE "visibility_types";
