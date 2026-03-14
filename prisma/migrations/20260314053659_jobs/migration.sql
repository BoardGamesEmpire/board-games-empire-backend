/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `categories` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[slug]` on the table `families` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[gateway_id,external_id]` on the table `game_sources` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[platform_type,external_id]` on the table `game_sources` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[slug]` on the table `mechanics` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `slug` to the `categories` table without a default value. This is not possible if the table is not empty.
  - Added the required column `slug` to the `families` table without a default value. This is not possible if the table is not empty.
  - Added the required column `slug` to the `mechanics` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "initiator_types" AS ENUM ('User', 'System', 'Scheduler');

-- CreateEnum
CREATE TYPE "job_types" AS ENUM ('GameImport', 'GameEnrich', 'ArtistEnrich', 'DesignerEnrich', 'PublisherEnrich', 'MechanicSync', 'CategorySync', 'FamilySync', 'CollectionSync', 'GatewaySeed');

-- CreateEnum
CREATE TYPE "job_statuses" AS ENUM ('Pending', 'Running', 'Completed', 'Failed', 'Cancelled');

-- DropIndex
DROP INDEX "game_sources_game_id_external_id_key";

-- AlterTable
ALTER TABLE "artists" ADD COLUMN     "enrichment_source" TEXT,
ADD COLUMN     "frozen_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "enrichment_source" TEXT,
ADD COLUMN     "frozen_at" TIMESTAMPTZ(3),
ADD COLUMN     "slug" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "designers" ADD COLUMN     "enrichment_source" TEXT,
ADD COLUMN     "frozen_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "families" ADD COLUMN     "enrichment_source" TEXT,
ADD COLUMN     "frozen_at" TIMESTAMPTZ(3),
ADD COLUMN     "slug" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "game_sources" ADD COLUMN     "platform_type" TEXT;

-- AlterTable
ALTER TABLE "games" ADD COLUMN     "bayes_rating" DOUBLE PRECISION,
ADD COLUMN     "enrichment_source" TEXT,
ADD COLUMN     "frozen_at" TIMESTAMPTZ(3),
ADD COLUMN     "ratings_count" INTEGER;

-- AlterTable
ALTER TABLE "mechanics" ADD COLUMN     "enrichment_source" TEXT,
ADD COLUMN     "frozen_at" TIMESTAMPTZ(3),
ADD COLUMN     "slug" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "publishers" ADD COLUMN     "enrichment_source" TEXT,
ADD COLUMN     "frozen_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "artist_gateway_links" (
    "id" TEXT NOT NULL,
    "artist_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "platform_type" TEXT NOT NULL,
    "external_name" TEXT,

    CONSTRAINT "artist_gateway_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "category_gateway_aliases" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "platform_type" TEXT NOT NULL,
    "external_name" TEXT NOT NULL,

    CONSTRAINT "category_gateway_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "designer_gateway_links" (
    "id" TEXT NOT NULL,
    "designer_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "platform_type" TEXT NOT NULL,
    "external_name" TEXT,

    CONSTRAINT "designer_gateway_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_gateway_aliases" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "platform_type" TEXT NOT NULL,
    "external_name" TEXT NOT NULL,

    CONSTRAINT "family_gateway_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mechanic_gateway_aliases" (
    "id" TEXT NOT NULL,
    "mechanic_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "platform_type" TEXT NOT NULL,
    "external_name" TEXT NOT NULL,

    CONSTRAINT "mechanic_gateway_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_gateway_links" (
    "id" TEXT NOT NULL,
    "publisher_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "platform_type" TEXT NOT NULL,
    "external_name" TEXT,

    CONSTRAINT "publisher_gateway_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "type" "job_types" NOT NULL,
    "status" "job_statuses" NOT NULL DEFAULT 'Pending',
    "initiator_type" "initiator_types" NOT NULL DEFAULT 'User',
    "user_id" TEXT,
    "game_id" TEXT,
    "batch_id" TEXT,
    "bullmq_job_id" TEXT,
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "note" TEXT,
    "parent_job_id" TEXT,
    "scheduled_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artist_gateway_links_artist_id_idx" ON "artist_gateway_links"("artist_id");

-- CreateIndex
CREATE UNIQUE INDEX "artist_gateway_links_gateway_id_external_id_key" ON "artist_gateway_links"("gateway_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "artist_gateway_links_platform_type_external_id_key" ON "artist_gateway_links"("platform_type", "external_id");

-- CreateIndex
CREATE INDEX "category_gateway_aliases_category_id_idx" ON "category_gateway_aliases"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_gateway_aliases_gateway_id_external_id_key" ON "category_gateway_aliases"("gateway_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "category_gateway_aliases_platform_type_external_id_key" ON "category_gateway_aliases"("platform_type", "external_id");

-- CreateIndex
CREATE INDEX "designer_gateway_links_designer_id_idx" ON "designer_gateway_links"("designer_id");

-- CreateIndex
CREATE UNIQUE INDEX "designer_gateway_links_gateway_id_external_id_key" ON "designer_gateway_links"("gateway_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "designer_gateway_links_platform_type_external_id_key" ON "designer_gateway_links"("platform_type", "external_id");

-- CreateIndex
CREATE INDEX "family_gateway_aliases_family_id_idx" ON "family_gateway_aliases"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "family_gateway_aliases_gateway_id_external_id_key" ON "family_gateway_aliases"("gateway_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "family_gateway_aliases_platform_type_external_id_key" ON "family_gateway_aliases"("platform_type", "external_id");

-- CreateIndex
CREATE INDEX "mechanic_gateway_aliases_mechanic_id_idx" ON "mechanic_gateway_aliases"("mechanic_id");

-- CreateIndex
CREATE UNIQUE INDEX "mechanic_gateway_aliases_gateway_id_external_id_key" ON "mechanic_gateway_aliases"("gateway_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "mechanic_gateway_aliases_platform_type_external_id_key" ON "mechanic_gateway_aliases"("platform_type", "external_id");

-- CreateIndex
CREATE INDEX "publisher_gateway_links_publisher_id_idx" ON "publisher_gateway_links"("publisher_id");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_gateway_links_gateway_id_external_id_key" ON "publisher_gateway_links"("gateway_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_gateway_links_platform_type_external_id_key" ON "publisher_gateway_links"("platform_type", "external_id");

-- CreateIndex
CREATE INDEX "jobs_parent_job_id_idx" ON "jobs"("parent_job_id");

-- CreateIndex
CREATE INDEX "jobs_user_id_type_idx" ON "jobs"("user_id", "type");

-- CreateIndex
CREATE INDEX "jobs_initiator_type_type_idx" ON "jobs"("initiator_type", "type");

-- CreateIndex
CREATE INDEX "jobs_batch_id_idx" ON "jobs"("batch_id");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "families_slug_key" ON "families"("slug");

-- CreateIndex
CREATE INDEX "game_sources_game_id_idx" ON "game_sources"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_sources_gateway_id_external_id_key" ON "game_sources"("gateway_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_sources_platform_type_external_id_key" ON "game_sources"("platform_type", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "mechanics_slug_key" ON "mechanics"("slug");

-- AddForeignKey
ALTER TABLE "artist_gateway_links" ADD CONSTRAINT "artist_gateway_links_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_gateway_aliases" ADD CONSTRAINT "category_gateway_aliases_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designer_gateway_links" ADD CONSTRAINT "designer_gateway_links_designer_id_fkey" FOREIGN KEY ("designer_id") REFERENCES "designers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "family_gateway_aliases" ADD CONSTRAINT "family_gateway_aliases_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mechanic_gateway_aliases" ADD CONSTRAINT "mechanic_gateway_aliases_mechanic_id_fkey" FOREIGN KEY ("mechanic_id") REFERENCES "mechanics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publisher_gateway_links" ADD CONSTRAINT "publisher_gateway_links_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_fkey" FOREIGN KEY ("parent_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
