-- #718: each DataGateway's platform, category and mechanic links gain a review
-- status, the alias tables become links, and each list job records its
-- outcome per DataGateway and section.
--
-- Written by hand around renames. Left to itself, Prisma drops the three
-- `*_gateway_aliases` tables and creates `*_gateway_links`, losing every row.
-- Renames keep the rows. Every link that exists today was written by import
-- and points at a record, so it becomes Resolved with origin Import, and a
-- platform link takes what accept needs from the platform it points at.

-- A section's failure is no longer an interview's: the code leaves the enum,
-- and an interview whose only failure was a section counts as clean.
UPDATE "data_gateways"
SET "last_interview_failure" = NULL, "last_interview_failed_at" = NULL
WHERE "last_interview_failure" = 'LanguageSectionFailed';

-- AlterEnum
BEGIN;
CREATE TYPE "data_gateway_interview_failures_new" AS ENUM ('PingFailed', 'DescribeUnsupported', 'DescribeFailed');
ALTER TABLE "data_gateways" ALTER COLUMN "last_interview_failure" TYPE "data_gateway_interview_failures_new" USING ("last_interview_failure"::text::"data_gateway_interview_failures_new");
ALTER TYPE "data_gateway_interview_failures" RENAME TO "data_gateway_interview_failures_old";
ALTER TYPE "data_gateway_interview_failures_new" RENAME TO "data_gateway_interview_failures";
DROP TYPE "public"."data_gateway_interview_failures_old";
COMMIT;

-- AlterEnum
ALTER TYPE "data_gateway_capabilities" ADD VALUE 'ListPlatforms';
ALTER TYPE "data_gateway_capabilities" ADD VALUE 'ListCategories';
ALTER TYPE "data_gateway_capabilities" ADD VALUE 'ListMechanics';

-- CreateEnum
CREATE TYPE "vocabulary_link_statuses" AS ENUM ('Resolved', 'Pending', 'Ignored');

-- CreateEnum
CREATE TYPE "vocabulary_link_origins" AS ENUM ('Interview', 'Import');

-- CreateEnum
CREATE TYPE "data_gateway_section_failures" AS ENUM ('ListUnsupported', 'ListFailed', 'LinkFailed');

-- RenameTable
ALTER TABLE "category_gateway_aliases" RENAME TO "category_gateway_links";
ALTER TABLE "category_gateway_links" RENAME CONSTRAINT "category_gateway_aliases_pkey" TO "category_gateway_links_pkey";
ALTER TABLE "category_gateway_links" RENAME CONSTRAINT "category_gateway_aliases_category_id_fkey" TO "category_gateway_links_category_id_fkey";
ALTER INDEX "category_gateway_aliases_category_id_idx" RENAME TO "category_gateway_links_category_id_idx";
ALTER INDEX "category_gateway_aliases_gateway_id_external_id_key" RENAME TO "category_gateway_links_gateway_id_external_id_key";

-- RenameTable
ALTER TABLE "mechanic_gateway_aliases" RENAME TO "mechanic_gateway_links";
ALTER TABLE "mechanic_gateway_links" RENAME CONSTRAINT "mechanic_gateway_aliases_pkey" TO "mechanic_gateway_links_pkey";
ALTER TABLE "mechanic_gateway_links" RENAME CONSTRAINT "mechanic_gateway_aliases_mechanic_id_fkey" TO "mechanic_gateway_links_mechanic_id_fkey";
ALTER INDEX "mechanic_gateway_aliases_mechanic_id_idx" RENAME TO "mechanic_gateway_links_mechanic_id_idx";
ALTER INDEX "mechanic_gateway_aliases_gateway_id_external_id_key" RENAME TO "mechanic_gateway_links_gateway_id_external_id_key";

-- RenameTable
ALTER TABLE "family_gateway_aliases" RENAME TO "family_gateway_links";
ALTER TABLE "family_gateway_links" RENAME CONSTRAINT "family_gateway_aliases_pkey" TO "family_gateway_links_pkey";
ALTER TABLE "family_gateway_links" RENAME CONSTRAINT "family_gateway_aliases_family_id_fkey" TO "family_gateway_links_family_id_fkey";
ALTER INDEX "family_gateway_aliases_family_id_idx" RENAME TO "family_gateway_links_family_id_idx";
ALTER INDEX "family_gateway_aliases_gateway_id_external_id_key" RENAME TO "family_gateway_links_gateway_id_external_id_key";

-- AlterTable: the defaults only fill the existing rows. Every writer sets the
-- status and origin itself, as the models give them no default.
ALTER TABLE "category_gateway_links" RENAME COLUMN "external_name" TO "supplied_name";
ALTER TABLE "category_gateway_links" ALTER COLUMN "category_id" DROP NOT NULL,
ADD COLUMN     "status" "vocabulary_link_statuses" NOT NULL DEFAULT 'Resolved',
ADD COLUMN     "origin" "vocabulary_link_origins" NOT NULL DEFAULT 'Import',
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "category_gateway_links" ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "origin" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "category_gateway_links_status_idx" ON "category_gateway_links"("status");

-- AlterTable
ALTER TABLE "mechanic_gateway_links" RENAME COLUMN "external_name" TO "supplied_name";
ALTER TABLE "mechanic_gateway_links" ALTER COLUMN "mechanic_id" DROP NOT NULL,
ADD COLUMN     "status" "vocabulary_link_statuses" NOT NULL DEFAULT 'Resolved',
ADD COLUMN     "origin" "vocabulary_link_origins" NOT NULL DEFAULT 'Import',
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "mechanic_gateway_links" ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "origin" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "mechanic_gateway_links_status_idx" ON "mechanic_gateway_links"("status");

-- AlterTable
ALTER TABLE "platform_gateway_links" ALTER COLUMN "platform_id" DROP NOT NULL,
ADD COLUMN     "status" "vocabulary_link_statuses" NOT NULL DEFAULT 'Resolved',
ADD COLUMN     "origin" "vocabulary_link_origins" NOT NULL DEFAULT 'Import',
ADD COLUMN     "supplied_name" TEXT,
ADD COLUMN     "supplied_abbreviation" TEXT,
ADD COLUMN     "supplied_platform_type" "platform_types",
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "platform_gateway_links" ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "origin" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- Every existing platform link points at a platform, so each one takes what
-- the DataGateway sent from there.
UPDATE "platform_gateway_links" l
SET "supplied_name" = p."name", "supplied_abbreviation" = p."abbreviation", "supplied_platform_type" = p."platform_type"
FROM "platforms" p
WHERE p."id" = l."platform_id";

ALTER TABLE "platform_gateway_links" ALTER COLUMN "supplied_name" SET NOT NULL,
ALTER COLUMN "supplied_platform_type" SET NOT NULL;

-- CreateIndex
CREATE INDEX "platform_gateway_links_status_idx" ON "platform_gateway_links"("status");

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "review_gateway_platforms" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "review_gateway_categories" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "review_gateway_mechanics" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "data_gateway_sections" (
    "gateway_id" TEXT NOT NULL,
    "capability" "data_gateway_capabilities" NOT NULL,
    "last_loaded_at" TIMESTAMPTZ(3),
    "last_failed_at" TIMESTAMPTZ(3),
    "last_failure" "data_gateway_section_failures",

    CONSTRAINT "data_gateway_sections_pkey" PRIMARY KEY ("gateway_id","capability")
);

-- AddForeignKey
ALTER TABLE "data_gateway_sections" ADD CONSTRAINT "data_gateway_sections_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "data_gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;
