/*
  Warnings:

  - You are about to drop the column `game_version_id` on the `game_play_sessions` table. All the data in the column will be lost.
  - You are about to drop the `game_version_rule_variants` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `game_versions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `rule_variant_usage_versions` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[platform_game_id,edition_key,region]` on the table `game_releases` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `edition_key` to the `game_releases` table without a default value. This is not possible if the table is not empty.
  - Made the column `game_id` on table `rule_variants` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "rule_variant_scopes" AS ENUM ('Game', 'PlatformType', 'PlatformGame', 'Release');

-- DropForeignKey
ALTER TABLE "game_play_sessions" DROP CONSTRAINT "game_play_sessions_game_version_id_fkey";

-- DropForeignKey
ALTER TABLE "game_version_rule_variants" DROP CONSTRAINT "game_version_rule_variants_game_version_id_fkey";

-- DropForeignKey
ALTER TABLE "game_version_rule_variants" DROP CONSTRAINT "game_version_rule_variants_rule_variant_id_fkey";

-- DropForeignKey
ALTER TABLE "game_version_rule_variants" DROP CONSTRAINT "game_version_rule_variants_rule_variant_usage_id_fkey";

-- DropForeignKey
ALTER TABLE "game_versions" DROP CONSTRAINT "game_versions_game_id_fkey";

-- DropForeignKey
ALTER TABLE "game_versions" DROP CONSTRAINT "game_versions_parent_version_id_fkey";

-- DropForeignKey
ALTER TABLE "rule_variant_usage_versions" DROP CONSTRAINT "rule_variant_usage_versions_game_version_id_fkey";

-- DropForeignKey
ALTER TABLE "rule_variant_usage_versions" DROP CONSTRAINT "rule_variant_usage_versions_rule_variant_usage_id_fkey";

-- DropForeignKey
ALTER TABLE "rule_variants" DROP CONSTRAINT "rule_variants_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "rule_variants" DROP CONSTRAINT "rule_variants_game_id_fkey";

-- DropIndex
DROP INDEX "game_releases_platform_game_id_region_key";

-- AlterTable
ALTER TABLE "event_game_nominations" ADD COLUMN     "release_id" TEXT;

-- AlterTable
ALTER TABLE "event_games" ADD COLUMN     "release_id" TEXT;

-- AlterTable
ALTER TABLE "game_collections" ADD COLUMN     "release_id" TEXT;

-- AlterTable
ALTER TABLE "game_lists" ADD COLUMN     "release_id" TEXT;

-- AlterTable
ALTER TABLE "game_play_sessions" DROP COLUMN "game_version_id",
ADD COLUMN     "release_id" TEXT;

-- AlterTable
ALTER TABLE "game_releases" ADD COLUMN     "edition_key" TEXT NOT NULL,
ADD COLUMN     "edition_name" TEXT,
ADD COLUMN     "max_play_time" INTEGER,
ADD COLUMN     "max_players" INTEGER,
ADD COLUMN     "min_play_time" INTEGER,
ADD COLUMN     "min_players" INTEGER,
ADD COLUMN     "parent_release_id" TEXT,
ADD COLUMN     "release_year" INTEGER;

-- AlterTable
ALTER TABLE "rule_variant_usages" ADD COLUMN     "errata_details" TEXT,
ADD COLUMN     "requires_errata" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "rule_variants" ADD COLUMN     "created_by_name" TEXT,
ADD COLUMN     "platform_game_id" TEXT,
ADD COLUMN     "release_id" TEXT,
ADD COLUMN     "scope" "rule_variant_scopes" NOT NULL DEFAULT 'Game',
ALTER COLUMN "game_id" SET NOT NULL,
ALTER COLUMN "created_by_id" DROP NOT NULL;

-- DropTable
DROP TABLE "game_version_rule_variants";

-- DropTable
DROP TABLE "game_versions";

-- DropTable
DROP TABLE "rule_variant_usage_versions";

-- CreateTable
CREATE TABLE "game_release_dlc_languages" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "language_id" TEXT NOT NULL,

    CONSTRAINT "game_release_dlc_languages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_variant_platform_types" (
    "id" TEXT NOT NULL,
    "rule_variant_id" TEXT NOT NULL,
    "platform_type" "platform_types" NOT NULL,

    CONSTRAINT "rule_variant_platform_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_release_dlc_languages_release_id_idx" ON "game_release_dlc_languages"("release_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_release_dlc_languages_release_id_language_id_key" ON "game_release_dlc_languages"("release_id", "language_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_variant_platform_types_rule_variant_id_platform_type_key" ON "rule_variant_platform_types"("rule_variant_id", "platform_type");

-- CreateIndex
CREATE INDEX "event_game_nominations_release_id_idx" ON "event_game_nominations"("release_id");

-- CreateIndex
CREATE INDEX "event_game_nominations_platform_game_id_idx" ON "event_game_nominations"("platform_game_id");

-- CreateIndex
CREATE INDEX "event_games_release_id_idx" ON "event_games"("release_id");

-- CreateIndex
CREATE INDEX "event_games_platform_game_id_idx" ON "event_games"("platform_game_id");

-- CreateIndex
CREATE INDEX "game_collections_release_id_idx" ON "game_collections"("release_id");

-- CreateIndex
CREATE INDEX "game_lists_platform_game_id_idx" ON "game_lists"("platform_game_id");

-- CreateIndex
CREATE INDEX "game_lists_release_id_idx" ON "game_lists"("release_id");

-- CreateIndex
CREATE INDEX "game_play_sessions_release_id_idx" ON "game_play_sessions"("release_id");

-- CreateIndex
CREATE INDEX "game_play_sessions_household_id_idx" ON "game_play_sessions"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_releases_platform_game_id_edition_key_region_key" ON "game_releases"("platform_game_id", "edition_key", "region");

-- CreateIndex
CREATE INDEX "rule_variants_scope_idx" ON "rule_variants"("scope");

-- CreateIndex
CREATE INDEX "rule_variants_platform_game_id_game_id_idx" ON "rule_variants"("platform_game_id", "game_id");

-- AddForeignKey
ALTER TABLE "event_game_nominations" ADD CONSTRAINT "event_game_nominations_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_collections" ADD CONSTRAINT "game_collections_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_release_dlc_languages" ADD CONSTRAINT "game_release_dlc_languages_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_dlc_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_release_dlc_languages" ADD CONSTRAINT "game_release_dlc_languages_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_releases" ADD CONSTRAINT "game_releases_parent_release_id_fkey" FOREIGN KEY ("parent_release_id") REFERENCES "game_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_lists" ADD CONSTRAINT "game_lists_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variants" ADD CONSTRAINT "rule_variants_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variants" ADD CONSTRAINT "rule_variants_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variants" ADD CONSTRAINT "rule_variants_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variants" ADD CONSTRAINT "rule_variants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variant_platform_types" ADD CONSTRAINT "rule_variant_platform_types_rule_variant_id_fkey" FOREIGN KEY ("rule_variant_id") REFERENCES "rule_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
