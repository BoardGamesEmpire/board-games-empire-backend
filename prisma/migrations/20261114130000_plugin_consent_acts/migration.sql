/*
  Warnings:

  - You are about to drop the column `manifest_version` on the `plugin_grants` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "PluginConsentActKind" AS ENUM ('SwitchOn', 'Toggle', 'Review', 'InstallAccept', 'UpdateApprove');

-- AlterTable
ALTER TABLE "plugin_grants" DROP COLUMN "manifest_version",
ADD COLUMN     "act_id" TEXT;

-- CreateTable
CREATE TABLE "plugin_consent_acts" (
    "id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "plugin_slug" TEXT NOT NULL,
    "scope_type" "PluginGrantScope" NOT NULL,
    "scope_id" TEXT NOT NULL DEFAULT '',
    "kind" "PluginConsentActKind" NOT NULL,
    "manifest_version" TEXT NOT NULL,
    "manifest_sha256" TEXT NOT NULL,
    "presentation" JSONB NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3) NOT NULL,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_consent_acts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plugin_consent_acts_plugin_id_scope_type_scope_id_decided_a_idx" ON "plugin_consent_acts"("plugin_id", "scope_type", "scope_id", "decided_at");
