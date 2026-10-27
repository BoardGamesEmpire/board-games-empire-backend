-- #869: play time is stored in minutes. Imports never wrote a measure, so
-- only hand-made games could carry another unit, and a search filter can't
-- compare across units. Int32 minutes holds about 4,000 years; the client
-- formats minutes for display. Nothing is deployed, so nothing is converted.
ALTER TABLE "games" DROP COLUMN "min_play_time_measure", DROP COLUMN "max_play_time_measure";
ALTER TABLE "platform_games" DROP COLUMN "min_play_time_measure", DROP COLUMN "max_play_time_measure";
DROP TYPE "time_measures";

-- A typical play time beside the range was a third value for every reader to
-- reconcile, and no DataGateway fills it: BGG's playingtime stands for both
-- ends of the range when BGG gives none. A single time is a range whose ends
-- are equal.
ALTER TABLE "games" DROP COLUMN "playing_time";
ALTER TABLE "user_game_customizations" DROP COLUMN "playing_time";
