/*
  Warnings:

  - You are about to drop the column `file_size` on the `media` table. All the data in the column will be lost.
  - You are about to drop the column `mime_type` on the `media` table. All the data in the column will be lost.
  - You are about to drop the column `original_name` on the `media` table. All the data in the column will be lost.
  - You are about to drop the column `uploader_id` on the `media` table. All the data in the column will be lost.
  - You are about to drop the column `url` on the `media` table. All the data in the column will be lost.
  - You are about to drop the column `visibility` on the `media` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[media_object_id]` on the table `media` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `media_object_id` to the `media` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "contribution_origins" AS ENUM ('ExistingMedia', 'DirectUpload');

-- CreateEnum
CREATE TYPE "media_contribution_statuses" AS ENUM ('Pending', 'Approved', 'Rejected', 'Reclaimed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "resource_types" ADD VALUE 'MediaObject';
ALTER TYPE "resource_types" ADD VALUE 'MediaContribution';

-- DropForeignKey
ALTER TABLE "media" DROP CONSTRAINT "media_uploader_id_fkey";

-- AlterTable
ALTER TABLE "media" DROP COLUMN "file_size",
DROP COLUMN "mime_type",
DROP COLUMN "original_name",
DROP COLUMN "uploader_id",
DROP COLUMN "url",
DROP COLUMN "visibility",
ADD COLUMN     "media_object_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "contribution_reclaim_days" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "media_signing_secret" TEXT,
ADD COLUMN     "require_contribution_approval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_service_account" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "media_objects" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "uploader_id" TEXT NOT NULL,
    "visibility" "visibility_types" NOT NULL DEFAULT 'Private',
    "driver_slug" TEXT NOT NULL,
    "driver_key" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "etag" TEXT,
    "original_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_shares" (
    "id" TEXT NOT NULL,
    "media_object_id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "shared_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_contributions" (
    "id" TEXT NOT NULL,
    "media_object_id" TEXT NOT NULL,
    "subject_type" "resource_types" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "category" TEXT,
    "status" "media_contribution_statuses" NOT NULL DEFAULT 'Pending',
    "origin" "contribution_origins" NOT NULL,
    "contributed_by_id" TEXT NOT NULL,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "rejection_reason" TEXT,
    "reclaim_deadline" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_objects_owner_id_idx" ON "media_objects"("owner_id");

-- CreateIndex
CREATE INDEX "media_objects_uploader_id_idx" ON "media_objects"("uploader_id");

-- CreateIndex
CREATE INDEX "media_objects_checksum_idx" ON "media_objects"("checksum");

-- CreateIndex
CREATE UNIQUE INDEX "media_objects_driver_slug_driver_key_key" ON "media_objects"("driver_slug", "driver_key");

-- CreateIndex
CREATE INDEX "media_shares_household_id_idx" ON "media_shares"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_shares_media_object_id_household_id_key" ON "media_shares"("media_object_id", "household_id");

-- CreateIndex
CREATE INDEX "media_contributions_media_object_id_idx" ON "media_contributions"("media_object_id");

-- CreateIndex
CREATE INDEX "media_contributions_status_origin_reclaim_deadline_idx" ON "media_contributions"("status", "origin", "reclaim_deadline");

-- CreateIndex
CREATE INDEX "media_contributions_subject_type_subject_id_idx" ON "media_contributions"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_media_object_id_key" ON "media"("media_object_id");

-- AddForeignKey
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_shares" ADD CONSTRAINT "media_shares_media_object_id_fkey" FOREIGN KEY ("media_object_id") REFERENCES "media_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_shares" ADD CONSTRAINT "media_shares_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_shares" ADD CONSTRAINT "media_shares_shared_by_id_fkey" FOREIGN KEY ("shared_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_contributions" ADD CONSTRAINT "media_contributions_media_object_id_fkey" FOREIGN KEY ("media_object_id") REFERENCES "media_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_contributions" ADD CONSTRAINT "media_contributions_contributed_by_id_fkey" FOREIGN KEY ("contributed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_contributions" ADD CONSTRAINT "media_contributions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_media_object_id_fkey" FOREIGN KEY ("media_object_id") REFERENCES "media_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
