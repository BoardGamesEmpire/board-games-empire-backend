-- Version links leave the add-on link (#1391, #658): only a game of an add-on content type keeps its links to its base games. A version (an edition, remake, remaster, port or bundle) names its original on its DataGateway link alone.
DELETE FROM "game_expansions" AS ge USING "games" AS g WHERE g."id" = ge."expansion_game_id" AND g."content_type" NOT IN ('Expansion','DLC','Mod','StandaloneExpansion','Accessory');

ALTER TABLE "game_expansions" DROP COLUMN "expansion_type", DROP COLUMN "is_standalone";

DROP TYPE "expansion_types";

ALTER TABLE "platform_games" ADD COLUMN "content_type" "content_types";
