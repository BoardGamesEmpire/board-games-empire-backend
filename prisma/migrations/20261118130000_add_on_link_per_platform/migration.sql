-- Only add-ons keep an add-on link (#1391, #658): a game of any other content type (a remake, remaster, port, expanded edition or bundle) names its original on its DataGateway link instead.
DELETE FROM "game_expansions" AS ge USING "games" AS g WHERE g."id" = ge."expansion_game_id" AND g."content_type" NOT IN ('Expansion','DLC','Mod','StandaloneExpansion','Accessory');

ALTER TABLE "game_expansions" DROP COLUMN "expansion_type", DROP COLUMN "is_standalone";

DROP TYPE "expansion_types";

ALTER TABLE "platform_games" ADD COLUMN "content_type" "content_types";
