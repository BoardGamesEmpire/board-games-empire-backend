-- Who besides a household's members and guests may open its game pool (#367).
-- Every existing household starts at Private, the default, which no
-- household reach is narrower than.

-- AlterTable
ALTER TABLE "household_settings" ADD COLUMN     "game_pool_reach" "reach_types" NOT NULL DEFAULT 'Private';
