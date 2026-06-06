/*
  Warnings:

  - The values [ApiKey,Basic,Certificate,HMAC,JWT,OAuth,PSK] on the enum `auth_types` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "feedback_statuses" AS ENUM ('Acknowledged', 'Duplicate', 'InProgress', 'NeedsInfo', 'New', 'Resolved', 'WontFix');

-- CreateEnum
CREATE TYPE "feedback_categories" AS ENUM ('Bug', 'Crash', 'FeatureRequest');

-- CreateEnum
CREATE TYPE "feedback_contexts" AS ENUM ('Client', 'Server', 'Unknown');

-- CreateEnum
CREATE TYPE "feedback_severities" AS ENUM ('Low', 'Medium', 'High', 'Critical');

-- CreateEnum
CREATE TYPE "deployment_runtimes" AS ENUM ('Kubernetes', 'DockerCompose', 'Docker', 'StandaloneNode', 'Serverless', 'Unknown');

-- CreateEnum
CREATE TYPE "feedback_submission_statuses" AS ENUM ('Closed', 'Duplicate', 'Failed', 'Pending', 'Submitted');

-- AlterEnum
BEGIN;
CREATE TYPE "auth_types_new" AS ENUM ('MutualTls', 'Bearer', 'None');
ALTER TABLE "game_gateways" ALTER COLUMN "auth_type" TYPE "auth_types_new" USING ("auth_type"::text::"auth_types_new");
ALTER TYPE "auth_types" RENAME TO "auth_types_old";
ALTER TYPE "auth_types_new" RENAME TO "auth_types";
DROP TYPE "public"."auth_types_old";
COMMIT;

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "resource_types" ADD VALUE 'FeedbackReport';
ALTER TYPE "resource_types" ADD VALUE 'FeedbackSinkDispatch';

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "feedback_report_retention_days" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "feedback_report_server_redaction_enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "feedback_reports" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "message" TEXT NOT NULL,
    "category" "feedback_categories" NOT NULL,
    "context" "feedback_contexts" NOT NULL DEFAULT 'Unknown',
    "severity" "feedback_severities",
    "app_version" TEXT,
    "platform" TEXT,
    "locale" TEXT,
    "device_info" JSONB,
    "deployment_runtime" "deployment_runtimes" NOT NULL DEFAULT 'Unknown',
    "deployment_version" TEXT,
    "user_id" TEXT NOT NULL,
    "correlation_key" TEXT,
    "user_redacted_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "redaction_applied" BOOLEAN NOT NULL DEFAULT false,
    "server_redacted" BOOLEAN NOT NULL DEFAULT false,
    "status" "feedback_statuses" NOT NULL DEFAULT 'New',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feedback_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_submissions" (
    "id" TEXT NOT NULL,
    "feedback_report_id" TEXT NOT NULL,
    "sink_slug" TEXT NOT NULL,
    "status" "feedback_submission_statuses" NOT NULL DEFAULT 'Pending',
    "external_id" TEXT,
    "external_url" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feedback_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_report_documents" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "feedback_report_id" TEXT NOT NULL,
    "page_count" INTEGER,
    "language" TEXT,
    "caption" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "feedback_report_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_report_images" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "feedback_report_id" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "caption" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "feedback_report_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_reports_status_created_at_idx" ON "feedback_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "feedback_reports_created_at_idx" ON "feedback_reports"("created_at");

-- CreateIndex
CREATE INDEX "feedback_reports_user_id_idx" ON "feedback_reports"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_report_user_correlation_key_unique" ON "feedback_reports"("user_id", "correlation_key");

-- CreateIndex
CREATE INDEX "feedback_submissions_feedback_report_id_idx" ON "feedback_submissions"("feedback_report_id");

-- CreateIndex
CREATE INDEX "feedback_submissions_sink_slug_status_idx" ON "feedback_submissions"("sink_slug", "status");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_submissions_sink_slug_external_id_key" ON "feedback_submissions"("sink_slug", "external_id");

-- CreateIndex
CREATE INDEX "feedback_report_documents_feedback_report_id_idx" ON "feedback_report_documents"("feedback_report_id");

-- CreateIndex
CREATE INDEX "feedback_report_images_feedback_report_id_idx" ON "feedback_report_images"("feedback_report_id");

-- AddForeignKey
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_feedback_report_id_fkey" FOREIGN KEY ("feedback_report_id") REFERENCES "feedback_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_report_documents" ADD CONSTRAINT "feedback_report_documents_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_report_documents" ADD CONSTRAINT "feedback_report_documents_feedback_report_id_fkey" FOREIGN KEY ("feedback_report_id") REFERENCES "feedback_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_report_images" ADD CONSTRAINT "feedback_report_images_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_report_images" ADD CONSTRAINT "feedback_report_images_feedback_report_id_fkey" FOREIGN KEY ("feedback_report_id") REFERENCES "feedback_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
