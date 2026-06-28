/*
  Warnings:

  - You are about to drop the column `format` on the `event_documents` table. All the data in the column will be lost.
  - You are about to drop the column `page_count` on the `event_documents` table. All the data in the column will be lost.
  - You are about to drop the column `format` on the `event_images` table. All the data in the column will be lost.
  - You are about to drop the column `height` on the `event_images` table. All the data in the column will be lost.
  - You are about to drop the column `width` on the `event_images` table. All the data in the column will be lost.
  - You are about to drop the column `codec` on the `event_videos` table. All the data in the column will be lost.
  - You are about to drop the column `duration` on the `event_videos` table. All the data in the column will be lost.
  - You are about to drop the column `resolution` on the `event_videos` table. All the data in the column will be lost.
  - You are about to drop the column `page_count` on the `feedback_report_documents` table. All the data in the column will be lost.
  - You are about to drop the column `format` on the `feedback_report_images` table. All the data in the column will be lost.
  - You are about to drop the column `height` on the `feedback_report_images` table. All the data in the column will be lost.
  - You are about to drop the column `width` on the `feedback_report_images` table. All the data in the column will be lost.
  - You are about to drop the column `format` on the `game_documents` table. All the data in the column will be lost.
  - You are about to drop the column `page_count` on the `game_documents` table. All the data in the column will be lost.
  - You are about to drop the column `format` on the `game_images` table. All the data in the column will be lost.
  - You are about to drop the column `height` on the `game_images` table. All the data in the column will be lost.
  - You are about to drop the column `width` on the `game_images` table. All the data in the column will be lost.
  - You are about to drop the column `codec` on the `game_videos` table. All the data in the column will be lost.
  - You are about to drop the column `duration` on the `game_videos` table. All the data in the column will be lost.
  - You are about to drop the column `resolution` on the `game_videos` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[event_id,media_id]` on the table `event_documents` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[event_id,media_id]` on the table `event_images` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[event_id,media_id]` on the table `event_videos` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[feedback_report_id,media_id]` on the table `feedback_report_documents` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[feedback_report_id,media_id]` on the table `feedback_report_images` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[game_id,media_id]` on the table `game_documents` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[game_id,media_id]` on the table `game_images` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[game_id,media_id]` on the table `game_videos` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `duration` to the `media_objects` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "notification_types" ADD VALUE 'MediaContributionRejected';
ALTER TYPE "notification_types" ADD VALUE 'MediaContributionReclaimExpired';

-- AlterTable
ALTER TABLE "event_documents" DROP COLUMN "format",
DROP COLUMN "page_count";

-- AlterTable
ALTER TABLE "event_images" DROP COLUMN "format",
DROP COLUMN "height",
DROP COLUMN "width";

-- AlterTable
ALTER TABLE "event_videos" DROP COLUMN "codec",
DROP COLUMN "duration",
DROP COLUMN "resolution";

-- AlterTable
ALTER TABLE "feedback_report_documents" DROP COLUMN "page_count";

-- AlterTable
ALTER TABLE "feedback_report_images" DROP COLUMN "format",
DROP COLUMN "height",
DROP COLUMN "width";

-- AlterTable
ALTER TABLE "game_documents" DROP COLUMN "format",
DROP COLUMN "page_count";

-- AlterTable
ALTER TABLE "game_images" DROP COLUMN "format",
DROP COLUMN "height",
DROP COLUMN "width";

-- AlterTable
ALTER TABLE "game_videos" DROP COLUMN "codec",
DROP COLUMN "duration",
DROP COLUMN "resolution";

-- AlterTable
ALTER TABLE "media_objects" ADD COLUMN     "codec" TEXT,
ADD COLUMN     "duration" INTEGER NOT NULL,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "page_count" INTEGER,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "width" INTEGER;

-- CreateIndex
CREATE INDEX "event_documents_media_id_idx" ON "event_documents"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_documents_event_id_media_id_key" ON "event_documents"("event_id", "media_id");

-- CreateIndex
CREATE INDEX "event_images_media_id_idx" ON "event_images"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_images_event_id_media_id_key" ON "event_images"("event_id", "media_id");

-- CreateIndex
CREATE INDEX "event_videos_media_id_idx" ON "event_videos"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_videos_event_id_media_id_key" ON "event_videos"("event_id", "media_id");

-- CreateIndex
CREATE INDEX "feedback_report_documents_media_id_idx" ON "feedback_report_documents"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_report_documents_feedback_report_id_media_id_key" ON "feedback_report_documents"("feedback_report_id", "media_id");

-- CreateIndex
CREATE INDEX "feedback_report_images_media_id_idx" ON "feedback_report_images"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_report_images_feedback_report_id_media_id_key" ON "feedback_report_images"("feedback_report_id", "media_id");

-- CreateIndex
CREATE INDEX "game_documents_media_id_idx" ON "game_documents"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_documents_game_id_media_id_key" ON "game_documents"("game_id", "media_id");

-- CreateIndex
CREATE INDEX "game_images_media_id_idx" ON "game_images"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_images_game_id_media_id_key" ON "game_images"("game_id", "media_id");

-- CreateIndex
CREATE INDEX "game_videos_media_id_idx" ON "game_videos"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_videos_game_id_media_id_key" ON "game_videos"("game_id", "media_id");
