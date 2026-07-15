-- CreateEnum
CREATE TYPE "language_tag_sources" AS ENUM ('Curated', 'Gateway');

-- CreateEnum
CREATE TYPE "language_code_formats" AS ENUM ('Iso6391', 'Iso6393', 'IetfBcp47', 'Name', 'NativeName');

-- CreateEnum
CREATE TYPE "language_link_statuses" AS ENUM ('Resolved', 'Pending', 'Unresolved', 'Ignored');

-- CreateEnum
CREATE TYPE "language_link_origins" AS ENUM ('Interview', 'Import');

-- DropForeignKey
ALTER TABLE "game_release_dlc_languages" DROP CONSTRAINT "game_release_dlc_languages_language_id_fkey";

-- DropForeignKey
ALTER TABLE "game_release_languages" DROP CONSTRAINT "game_release_languages_language_id_fkey";

-- DropForeignKey
ALTER TABLE "households" DROP CONSTRAINT "households_language_id_fkey";

-- DropForeignKey
ALTER TABLE "user_preferences" DROP CONSTRAINT "user_preferences_language_id_fkey";

-- DropIndex
DROP INDEX "game_release_dlc_languages_release_id_language_id_key";

-- DropIndex
DROP INDEX "game_release_languages_release_id_language_id_key";

-- DropIndex
DROP INDEX "languages_abbreviation_key";

-- DropIndex
DROP INDEX "languages_code_key";

-- AlterTable
ALTER TABLE "game_gateways" ADD COLUMN     "languages_synced_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "game_release_dlc_languages" DROP COLUMN "language_id",
ADD COLUMN     "language_tag_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "game_release_languages" DROP COLUMN "language_id",
ADD COLUMN     "language_tag_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "households" DROP COLUMN "language_id",
ADD COLUMN     "language_tag_id" TEXT;

-- AlterTable
ALTER TABLE "languages" DROP COLUMN "abbreviation",
DROP COLUMN "code",
DROP COLUMN "system_supported",
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "iso6391" VARCHAR(2),
ADD COLUMN     "iso6393" VARCHAR(3) NOT NULL,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL;

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "review_gateway_languages" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "user_preferences" DROP COLUMN "language_id",
ADD COLUMN     "language_tag_id" TEXT;

-- CreateTable
CREATE TABLE "language_tags" (
    "id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "script" VARCHAR(4),
    "region" VARCHAR(3),
    "name" TEXT NOT NULL,
    "native_name" TEXT,
    "system_supported" BOOLEAN NOT NULL DEFAULT false,
    "source" "language_tag_sources" NOT NULL DEFAULT 'Curated',
    "language_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "language_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "language_gateway_links" (
    "id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "format" "language_code_formats" NOT NULL,
    "status" "language_link_statuses" NOT NULL DEFAULT 'Unresolved',
    "origin" "language_link_origins" NOT NULL,
    "tag_id" TEXT,
    "supplied_iso6393" VARCHAR(3),
    "supplied_iso6391" VARCHAR(2),
    "supplied_name" TEXT,
    "supplied_native_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "language_gateway_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "language_tags_tag_key" ON "language_tags"("tag");

-- CreateIndex
CREATE INDEX "language_tags_language_id_idx" ON "language_tags"("language_id");

-- CreateIndex
CREATE INDEX "language_gateway_links_status_idx" ON "language_gateway_links"("status");

-- CreateIndex
CREATE UNIQUE INDEX "language_gateway_links_gateway_id_value_format_key" ON "language_gateway_links"("gateway_id", "value", "format");

-- CreateIndex
CREATE UNIQUE INDEX "game_release_dlc_languages_release_id_language_tag_id_key" ON "game_release_dlc_languages"("release_id", "language_tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_release_languages_release_id_language_tag_id_key" ON "game_release_languages"("release_id", "language_tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "languages_iso6393_key" ON "languages"("iso6393");

-- CreateIndex
CREATE UNIQUE INDEX "languages_iso6391_key" ON "languages"("iso6391");

-- AddForeignKey
ALTER TABLE "game_release_dlc_languages" ADD CONSTRAINT "game_release_dlc_languages_language_tag_id_fkey" FOREIGN KEY ("language_tag_id") REFERENCES "language_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_release_languages" ADD CONSTRAINT "game_release_languages_language_tag_id_fkey" FOREIGN KEY ("language_tag_id") REFERENCES "language_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "households" ADD CONSTRAINT "households_language_tag_id_fkey" FOREIGN KEY ("language_tag_id") REFERENCES "language_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "language_tags" ADD CONSTRAINT "language_tags_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "languages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "language_gateway_links" ADD CONSTRAINT "language_gateway_links_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "language_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_language_tag_id_fkey" FOREIGN KEY ("language_tag_id") REFERENCES "language_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

