-- #712: a DataGateway's answers to the server's interview are stored on its
-- row, with the interview's status. They replace languages_synced_at, which
-- only timed the language interview. Existing rows come back un-interviewed:
-- the next connect interviews them, and the server doesn't route to a
-- DataGateway until its first interview succeeds.

-- CreateEnum
CREATE TYPE "data_gateway_capabilities" AS ENUM ('Search', 'Fetch', 'FetchExpansions', 'ListLanguages');

-- CreateEnum
CREATE TYPE "coverage_axes" AS ENUM ('PlatformType', 'ContentType');

-- CreateEnum
CREATE TYPE "content_formats" AS ENUM ('PlainText', 'Html', 'BBCode', 'Markdown');

-- CreateEnum
CREATE TYPE "data_gateway_interview_failures" AS ENUM ('PingFailed', 'DescribeUnsupported', 'DescribeFailed', 'LanguageSectionFailed');

-- AlterTable
ALTER TABLE "data_gateways" DROP COLUMN "languages_synced_at",
ADD COLUMN     "accepted_language_code_formats" "language_code_formats"[] DEFAULT ARRAY[]::"language_code_formats"[],
ADD COLUMN     "capabilities" "data_gateway_capabilities"[] DEFAULT ARRAY[]::"data_gateway_capabilities"[],
ADD COLUMN     "content_format" "content_formats",
ADD COLUMN     "coverage_content_types" "content_types"[] DEFAULT ARRAY[]::"content_types"[],
ADD COLUMN     "coverage_platform_types" "platform_types"[] DEFAULT ARRAY[]::"platform_types"[],
ADD COLUMN     "disabled_capabilities" "data_gateway_capabilities"[] DEFAULT ARRAY[]::"data_gateway_capabilities"[],
ADD COLUMN     "filterable_axes" "coverage_axes"[] DEFAULT ARRAY[]::"coverage_axes"[],
ADD COLUMN     "first_interviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "gateway_version" TEXT,
ADD COLUMN     "last_interview_failed_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_interview_failure" "data_gateway_interview_failures",
ADD COLUMN     "last_interviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "passthrough_search_language" BOOLEAN,
ADD COLUMN     "response_language_code_format" "language_code_formats";
