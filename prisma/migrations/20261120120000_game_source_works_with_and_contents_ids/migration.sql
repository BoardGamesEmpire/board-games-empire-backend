-- #1392, #1394: a DataGateway link stores the external ids of the games its
-- game works with, contains and belongs to. `GET /games/:id` matches them either
-- way round on the same DataGateway, so no table stores the links. The GIN
-- indexes serve the reverse lookup (`works_with_external_ids @> ARRAY[...]`).
-- Existing rows start empty and fill in as their games are imported again.

-- AlterTable
ALTER TABLE "game_sources" ADD COLUMN     "works_with_external_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "content_external_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "bundle_external_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "game_sources_works_with_external_ids_idx" ON "game_sources" USING GIN ("works_with_external_ids");

-- CreateIndex
CREATE INDEX "game_sources_content_external_ids_idx" ON "game_sources" USING GIN ("content_external_ids");

-- CreateIndex
CREATE INDEX "game_sources_bundle_external_ids_idx" ON "game_sources" USING GIN ("bundle_external_ids");
