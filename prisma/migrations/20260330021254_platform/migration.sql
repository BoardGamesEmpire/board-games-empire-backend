/*
  Warnings:

  - You are about to drop the column `release_date` on the `game_sources` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "release_regions" AS ENUM ('Worldwide', 'NorthAmerica', 'Europe', 'Japan', 'Australia', 'Asia', 'Brazil', 'Korea');

-- CreateEnum
CREATE TYPE "platform_types" AS ENUM ('Tabletop', 'Console', 'PC', 'Mobile', 'Other');

-- AlterTable
ALTER TABLE "game_sources" DROP COLUMN "release_date";

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN "filter_search_by_language" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "languages" ADD COLUMN     "native_name" TEXT,
ADD COLUMN     "system_supported" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "abbreviation" DROP NOT NULL;

-- CreateTable
CREATE TABLE "game_dlc" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "thumbnail" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_dlc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_dlc_gateway_links" (
    "id" TEXT NOT NULL,
    "dlc_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "source_url" TEXT,

    CONSTRAINT "game_dlc_gateway_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_dlc_releases" (
    "id" TEXT NOT NULL,
    "dlc_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "region" "release_regions" NOT NULL DEFAULT 'Worldwide',
    "release_date" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_dlc_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_releases" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "region" "release_regions" NOT NULL DEFAULT 'Worldwide',
    "release_date" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_release_languages" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "language_id" TEXT NOT NULL,

    CONSTRAINT "game_release_languages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platforms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "abbreviation" TEXT,
    "platform_type" "platform_types" NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "logo_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_gateway_links" (
    "id" TEXT NOT NULL,
    "platform_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,

    CONSTRAINT "platform_gateway_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "game_dlc_game_id_idx" ON "game_dlc"("game_id");

-- CreateIndex
CREATE INDEX "game_dlc_gateway_links_dlc_id_idx" ON "game_dlc_gateway_links"("dlc_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_dlc_gateway_links_gateway_id_external_id_key" ON "game_dlc_gateway_links"("gateway_id", "external_id");

-- CreateIndex
CREATE INDEX "game_dlc_releases_dlc_id_idx" ON "game_dlc_releases"("dlc_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_dlc_releases_dlc_id_platform_id_region_key" ON "game_dlc_releases"("dlc_id", "platform_id", "region");

-- CreateIndex
CREATE INDEX "game_releases_game_id_idx" ON "game_releases"("game_id");

-- CreateIndex
CREATE INDEX "game_releases_platform_id_idx" ON "game_releases"("platform_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_releases_game_id_platform_id_region_key" ON "game_releases"("game_id", "platform_id", "region");

-- CreateIndex
CREATE INDEX "game_release_languages_release_id_idx" ON "game_release_languages"("release_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_release_languages_release_id_language_id_key" ON "game_release_languages"("release_id", "language_id");

-- CreateIndex
CREATE UNIQUE INDEX "platforms_name_key" ON "platforms"("name");

-- CreateIndex
CREATE UNIQUE INDEX "platforms_slug_key" ON "platforms"("slug");

-- CreateIndex
CREATE INDEX "platform_gateway_links_platform_id_idx" ON "platform_gateway_links"("platform_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_gateway_links_gateway_id_external_id_key" ON "platform_gateway_links"("gateway_id", "external_id");

-- AddForeignKey
ALTER TABLE "game_dlc" ADD CONSTRAINT "game_dlc_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_dlc_gateway_links" ADD CONSTRAINT "game_dlc_gateway_links_dlc_id_fkey" FOREIGN KEY ("dlc_id") REFERENCES "game_dlc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_dlc_releases" ADD CONSTRAINT "game_dlc_releases_dlc_id_fkey" FOREIGN KEY ("dlc_id") REFERENCES "game_dlc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_dlc_releases" ADD CONSTRAINT "game_dlc_releases_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_releases" ADD CONSTRAINT "game_releases_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_releases" ADD CONSTRAINT "game_releases_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_release_languages" ADD CONSTRAINT "game_release_languages_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_release_languages" ADD CONSTRAINT "game_release_languages_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_gateway_links" ADD CONSTRAINT "platform_gateway_links_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
