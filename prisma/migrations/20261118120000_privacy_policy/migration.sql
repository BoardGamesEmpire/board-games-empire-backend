-- #934: the operator's privacy policy, one row per language. The enum needs the
-- new value because a direct user permission or an API key scope names the
-- resource type.

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'PrivacyPolicy';

-- CreateTable
CREATE TABLE "privacy_policies" (
    "id" TEXT NOT NULL,
    "language_tag_id" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "privacy_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "privacy_policies_language_tag_id_key" ON "privacy_policies"("language_tag_id");

-- AddForeignKey
ALTER TABLE "privacy_policies" ADD CONSTRAINT "privacy_policies_language_tag_id_fkey" FOREIGN KEY ("language_tag_id") REFERENCES "language_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
