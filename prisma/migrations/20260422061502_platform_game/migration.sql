/*
  Warnings:

  - You are about to drop the column `game_id` on the `event_game_nominations` table. All the data in the column will be lost.
  - You are about to drop the column `game_id` on the `event_games` table. All the data in the column will be lost.
  - You are about to drop the column `game_id` on the `game_collections` table. All the data in the column will be lost.
  - You are about to drop the column `game_id` on the `game_lists` table. All the data in the column will be lost.
  - You are about to drop the column `game_id` on the `game_play_session_expansions` table. All the data in the column will be lost.
  - You are about to drop the column `game_id` on the `game_play_sessions` table. All the data in the column will be lost.
  - You are about to drop the column `game_id` on the `game_releases` table. All the data in the column will be lost.
  - You are about to drop the column `platform_id` on the `game_releases` table. All the data in the column will be lost.
  - You are about to drop the column `game_id` on the `loaned_games` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[user_id,platform_game_id,medium]` on the table `game_collections` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[session_id,platform_game_id]` on the table `game_play_session_expansions` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[platform_game_id,region]` on the table `game_releases` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `platform_game_id` to the `event_game_nominations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platform_game_id` to the `event_games` table without a default value. This is not possible if the table is not empty.
  - Added the required column `medium` to the `game_collections` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platform_game_id` to the `game_collections` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platform_game_id` to the `game_lists` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platform_game_id` to the `game_play_session_expansions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platform_game_id` to the `game_play_sessions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `platform_game_id` to the `game_releases` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "game_mediums" AS ENUM ('Physical', 'Digital');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "content_types" ADD VALUE 'ExpandedEdition';
ALTER TYPE "content_types" ADD VALUE 'Mod';
ALTER TYPE "content_types" ADD VALUE 'Port';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "expansion_types" ADD VALUE 'ExpandedEdition';
ALTER TYPE "expansion_types" ADD VALUE 'Mod';
ALTER TYPE "expansion_types" ADD VALUE 'Port';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "resource_types" ADD VALUE 'Platform';
ALTER TYPE "resource_types" ADD VALUE 'PlatformGame';

-- DropForeignKey
ALTER TABLE "event_game_nominations" DROP CONSTRAINT "event_game_nominations_game_id_fkey";

-- DropForeignKey
ALTER TABLE "event_games" DROP CONSTRAINT "event_games_game_id_fkey";

-- DropForeignKey
ALTER TABLE "game_collections" DROP CONSTRAINT "game_collections_game_id_fkey";

-- DropForeignKey
ALTER TABLE "game_lists" DROP CONSTRAINT "game_lists_game_id_fkey";

-- DropForeignKey
ALTER TABLE "game_play_session_expansions" DROP CONSTRAINT "game_play_session_expansions_game_id_fkey";

-- DropForeignKey
ALTER TABLE "game_play_sessions" DROP CONSTRAINT "game_play_sessions_game_id_fkey";

-- DropForeignKey
ALTER TABLE "game_releases" DROP CONSTRAINT "game_releases_game_id_fkey";

-- DropForeignKey
ALTER TABLE "game_releases" DROP CONSTRAINT "game_releases_platform_id_fkey";

-- DropForeignKey
ALTER TABLE "loaned_games" DROP CONSTRAINT "loaned_games_game_id_fkey";

-- DropIndex
DROP INDEX "game_collections_user_id_game_id_key";

-- DropIndex
DROP INDEX "game_collections_user_id_idx";

-- DropIndex
DROP INDEX "game_play_session_expansions_session_id_game_id_key";

-- DropIndex
DROP INDEX "game_play_sessions_game_id_idx";

-- DropIndex
DROP INDEX "game_releases_game_id_idx";

-- DropIndex
DROP INDEX "game_releases_game_id_platform_id_region_key";

-- DropIndex
DROP INDEX "game_releases_platform_id_idx";

-- AlterTable
ALTER TABLE "event_game_nominations" DROP COLUMN "game_id",
ADD COLUMN     "platform_game_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "event_games" DROP COLUMN "game_id",
ADD COLUMN     "platform_game_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "game_collections" DROP COLUMN "game_id",
ADD COLUMN     "medium" "game_mediums" NOT NULL,
ADD COLUMN     "platform_game_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "game_lists" DROP COLUMN "game_id",
ADD COLUMN     "platform_game_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "game_play_session_expansions" DROP COLUMN "game_id",
ADD COLUMN     "platform_game_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "game_play_sessions" DROP COLUMN "game_id",
ADD COLUMN     "platform_game_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "game_releases" DROP COLUMN "game_id",
DROP COLUMN "platform_id",
ADD COLUMN     "platform_game_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "loaned_games" DROP COLUMN "game_id";

-- CreateTable
CREATE TABLE "occurrence_policy_platform_types" (
    "id" TEXT NOT NULL,
    "occurrence_policy_id" TEXT NOT NULL,
    "platform_type" "platform_types" NOT NULL,

    CONSTRAINT "occurrence_policy_platform_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occurrence_policy_platforms" (
    "id" TEXT NOT NULL,
    "occurrence_policy_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,

    CONSTRAINT "occurrence_policy_platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_policy_platform_types" (
    "id" TEXT NOT NULL,
    "event_policy_id" TEXT NOT NULL,
    "platform_type" "platform_types" NOT NULL,

    CONSTRAINT "event_policy_platform_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_policy_platforms" (
    "id" TEXT NOT NULL,
    "event_policy_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,

    CONSTRAINT "event_policy_platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_games" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "min_players" INTEGER,
    "max_players" INTEGER,
    "min_play_time" INTEGER,
    "min_play_time_measure" "time_measures",
    "max_play_time" INTEGER,
    "max_play_time_measure" "time_measures",
    "image" TEXT,
    "thumbnail" TEXT,
    "supports_solo" BOOLEAN NOT NULL DEFAULT false,
    "supports_local" BOOLEAN NOT NULL DEFAULT false,
    "supports_online" BOOLEAN NOT NULL DEFAULT false,
    "has_async_play" BOOLEAN NOT NULL DEFAULT false,
    "has_realtime" BOOLEAN NOT NULL DEFAULT false,
    "has_tutorial" BOOLEAN NOT NULL DEFAULT false,
    "enrichment_source" TEXT,
    "frozen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_games_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "occurrence_policy_platform_types_occurrence_policy_id_platf_key" ON "occurrence_policy_platform_types"("occurrence_policy_id", "platform_type");

-- CreateIndex
CREATE UNIQUE INDEX "occurrence_policy_platforms_occurrence_policy_id_platform_i_key" ON "occurrence_policy_platforms"("occurrence_policy_id", "platform_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_policy_platform_types_event_policy_id_platform_type_key" ON "event_policy_platform_types"("event_policy_id", "platform_type");

-- CreateIndex
CREATE UNIQUE INDEX "event_policy_platforms_event_policy_id_platform_id_key" ON "event_policy_platforms"("event_policy_id", "platform_id");

-- CreateIndex
CREATE INDEX "platform_games_game_id_idx" ON "platform_games"("game_id");

-- CreateIndex
CREATE INDEX "platform_games_platform_id_idx" ON "platform_games"("platform_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_games_game_id_platform_id_key" ON "platform_games"("game_id", "platform_id");

-- CreateIndex
CREATE INDEX "game_collections_platform_game_id_idx" ON "game_collections"("platform_game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_collections_user_id_platform_game_id_medium_key" ON "game_collections"("user_id", "platform_game_id", "medium");

-- CreateIndex
CREATE UNIQUE INDEX "game_play_session_expansions_session_id_platform_game_id_key" ON "game_play_session_expansions"("session_id", "platform_game_id");

-- CreateIndex
CREATE INDEX "game_play_sessions_platform_game_id_idx" ON "game_play_sessions"("platform_game_id");

-- CreateIndex
CREATE INDEX "game_releases_platform_game_id_idx" ON "game_releases"("platform_game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_releases_platform_game_id_region_key" ON "game_releases"("platform_game_id", "region");

-- AddForeignKey
ALTER TABLE "event_game_nominations" ADD CONSTRAINT "event_game_nominations_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence_policy_platform_types" ADD CONSTRAINT "occurrence_policy_platform_types_occurrence_policy_id_fkey" FOREIGN KEY ("occurrence_policy_id") REFERENCES "event_occurrence_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence_policy_platforms" ADD CONSTRAINT "occurrence_policy_platforms_occurrence_policy_id_fkey" FOREIGN KEY ("occurrence_policy_id") REFERENCES "event_occurrence_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence_policy_platforms" ADD CONSTRAINT "occurrence_policy_platforms_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_policy_platform_types" ADD CONSTRAINT "event_policy_platform_types_event_policy_id_fkey" FOREIGN KEY ("event_policy_id") REFERENCES "event_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_policy_platforms" ADD CONSTRAINT "event_policy_platforms_event_policy_id_fkey" FOREIGN KEY ("event_policy_id") REFERENCES "event_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_policy_platforms" ADD CONSTRAINT "event_policy_platforms_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_collections" ADD CONSTRAINT "game_collections_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_releases" ADD CONSTRAINT "game_releases_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_games" ADD CONSTRAINT "platform_games_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_games" ADD CONSTRAINT "platform_games_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_session_expansions" ADD CONSTRAINT "game_play_session_expansions_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_lists" ADD CONSTRAINT "game_lists_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
