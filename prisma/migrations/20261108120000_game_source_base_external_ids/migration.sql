-- #971: a DataGateway link stores the base games its DataGateway names for the
-- game, so importing a base game can find the add-ons already in the game
-- catalog. The GIN index serves that lookup (`base_external_ids @> ARRAY[...]`).
-- Existing rows start empty and fill in as their games are imported again.

-- AlterTable
ALTER TABLE "game_sources" ADD COLUMN     "base_external_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "game_sources_base_external_ids_idx" ON "game_sources" USING GIN ("base_external_ids");
