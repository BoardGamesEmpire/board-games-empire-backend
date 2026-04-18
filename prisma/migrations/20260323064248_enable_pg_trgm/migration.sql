/*
  Warnings:

  - You are about to drop the column `platform_type` on the `artist_gateway_links` table. All the data in the column will be lost.
  - You are about to drop the column `platform_type` on the `category_gateway_aliases` table. All the data in the column will be lost.
  - You are about to drop the column `platform_type` on the `designer_gateway_links` table. All the data in the column will be lost.
  - You are about to drop the column `platform_type` on the `family_gateway_aliases` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `game_expansions` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `game_expansions` table. All the data in the column will be lost.
  - You are about to drop the column `parent_expansion_id` on the `game_expansions` table. All the data in the column will be lost.
  - You are about to drop the column `release_year` on the `game_expansions` table. All the data in the column will be lost.
  - You are about to drop the column `expansion_id` on the `game_play_session_expansions` table. All the data in the column will be lost.
  - You are about to drop the column `platform_type` on the `game_sources` table. All the data in the column will be lost.
  - You are about to drop the column `platform_type` on the `mechanic_gateway_aliases` table. All the data in the column will be lost.
  - You are about to drop the column `platform_type` on the `publisher_gateway_links` table. All the data in the column will be lost.
  - You are about to drop the `expansion_compatibilities` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `rule_variant_usage_expansions` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[base_game_id,expansion_game_id]` on the table `game_expansions` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[session_id,game_id]` on the table `game_play_session_expansions` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `expansion_game_id` to the `game_expansions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `game_id` to the `game_play_session_expansions` table without a default value. This is not possible if the table is not empty.
  - Made the column `gateway_id` on table `game_sources` required. This step will fail if there are existing NULL values in that column.
  - Made the column `external_id` on table `game_sources` required. This step will fail if there are existing NULL values in that column.
*/

-- Might not apply from the init migration
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable
ALTER TABLE "households" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);

-- CreateEnum
CREATE TYPE "content_types" AS ENUM ('Accessory', 'BaseGame', 'Bundle', 'DLC', 'Expansion', 'Remake', 'Remaster', 'StandaloneExpansion', 'Unknown');

-- CreateEnum
CREATE TYPE "expansion_types" AS ENUM ('Accessory', 'DLC', 'Expansion', 'MiniExpansion', 'StandaloneExpansion');

-- CreateEnum
CREATE TYPE "notification_types" AS ENUM ('GameImported', 'ExpansionImported', 'WatchedExpansionImported');

-- DropForeignKey
ALTER TABLE "expansion_compatibilities" DROP CONSTRAINT "expansion_compatibilities_expansion_id_fkey";

-- DropForeignKey
ALTER TABLE "expansion_compatibilities" DROP CONSTRAINT "expansion_compatibilities_game_id_fkey";

-- DropForeignKey
ALTER TABLE "game_expansions" DROP CONSTRAINT "game_expansions_parent_expansion_id_fkey";

-- DropForeignKey
ALTER TABLE "game_play_session_expansions" DROP CONSTRAINT "game_play_session_expansions_expansion_id_fkey";

-- DropForeignKey
ALTER TABLE "game_sources" DROP CONSTRAINT "game_sources_gateway_id_fkey";

-- DropForeignKey
ALTER TABLE "rule_variant_usage_expansions" DROP CONSTRAINT "rule_variant_usage_expansions_game_expansion_id_fkey";

-- DropForeignKey
ALTER TABLE "rule_variant_usage_expansions" DROP CONSTRAINT "rule_variant_usage_expansions_rule_variant_usage_id_fkey";

-- DropIndex
DROP INDEX "artist_gateway_links_platform_type_external_id_key";

-- DropIndex
DROP INDEX "category_gateway_aliases_platform_type_external_id_key";

-- DropIndex
DROP INDEX "designer_gateway_links_platform_type_external_id_key";

-- DropIndex
DROP INDEX "family_gateway_aliases_platform_type_external_id_key";

-- DropIndex
DROP INDEX "game_expansions_base_game_id_idx";

-- DropIndex
DROP INDEX "game_expansions_parent_expansion_id_idx";

-- DropIndex
DROP INDEX "game_play_session_expansions_session_id_expansion_id_key";

-- DropIndex
DROP INDEX "game_sources_platform_type_external_id_key";

-- DropIndex
DROP INDEX "mechanic_gateway_aliases_platform_type_external_id_key";

-- DropIndex
DROP INDEX "publisher_gateway_links_platform_type_external_id_key";

-- AlterTable
ALTER TABLE "artist_gateway_links" DROP COLUMN "platform_type";

-- AlterTable
ALTER TABLE "category_gateway_aliases" DROP COLUMN "platform_type";

-- AlterTable
ALTER TABLE "designer_gateway_links" DROP COLUMN "platform_type";

-- AlterTable
ALTER TABLE "family_gateway_aliases" DROP COLUMN "platform_type";

-- AlterTable
ALTER TABLE "game_expansions" DROP COLUMN "description",
DROP COLUMN "name",
DROP COLUMN "parent_expansion_id",
DROP COLUMN "release_year",
ADD COLUMN     "expansion_game_id" TEXT NOT NULL,
ADD COLUMN     "expansion_type" "expansion_types" NOT NULL DEFAULT 'Expansion',
ADD COLUMN     "max_players_override" INTEGER,
ADD COLUMN     "min_players_override" INTEGER,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "play_time_modifier" INTEGER,
ADD COLUMN     "player_count_modifier" INTEGER,
ADD COLUMN     "recommended_play_order" INTEGER,
ADD COLUMN     "required_expansion_ids" TEXT[];

-- AlterTable
ALTER TABLE "game_play_session_expansions" DROP COLUMN "expansion_id",
ADD COLUMN     "game_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "game_sources" DROP COLUMN "platform_type",
ALTER COLUMN "gateway_id" SET NOT NULL,
ALTER COLUMN "external_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "games" ADD COLUMN     "content_type" "content_types" NOT NULL DEFAULT 'BaseGame';

-- AlterTable
ALTER TABLE "mechanic_gateway_aliases" DROP COLUMN "platform_type";

-- AlterTable
ALTER TABLE "publisher_gateway_links" DROP COLUMN "platform_type";

-- DropTable
DROP TABLE "expansion_compatibilities";

-- DropTable
DROP TABLE "rule_variant_usage_expansions";

-- CreateTable
CREATE TABLE "game_watches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "auto_import" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_watches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_activities" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "imported_by_id" TEXT,
    "gateway_id" TEXT NOT NULL,
    "is_expansion" BOOLEAN NOT NULL DEFAULT false,
    "game_title" TEXT NOT NULL,
    "thumbnail" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "notification_types" NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(3),
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_watches_game_id_idx" ON "game_watches"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_watches_user_id_game_id_key" ON "game_watches"("user_id", "game_id");

-- CreateIndex
CREATE INDEX "import_activities_created_at_idx" ON "import_activities"("created_at" DESC);

-- CreateIndex
CREATE INDEX "import_activities_imported_by_id_idx" ON "import_activities"("imported_by_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_created_at_idx" ON "notifications"("user_id", "read", "created_at" DESC);

-- CreateIndex
CREATE INDEX "game_expansions_expansion_game_id_idx" ON "game_expansions"("expansion_game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_expansions_base_game_id_expansion_game_id_key" ON "game_expansions"("base_game_id", "expansion_game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_play_session_expansions_session_id_game_id_key" ON "game_play_session_expansions"("session_id", "game_id");

-- CreateIndex
CREATE INDEX "idx_categories_name_trgm" ON "categories" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_families_name_trgm" ON "families" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "idx_mechanics_name_trgm" ON "mechanics" USING GIN ("name" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "game_expansions" ADD CONSTRAINT "game_expansions_expansion_game_id_fkey" FOREIGN KEY ("expansion_game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sources" ADD CONSTRAINT "game_sources_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "game_gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_watches" ADD CONSTRAINT "game_watches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_watches" ADD CONSTRAINT "game_watches_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_session_expansions" ADD CONSTRAINT "game_play_session_expansions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_activities" ADD CONSTRAINT "import_activities_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_activities" ADD CONSTRAINT "import_activities_imported_by_id_fkey" FOREIGN KEY ("imported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_activities" ADD CONSTRAINT "import_activities_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "game_gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
