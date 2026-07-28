-- AlterEnum
-- plugin.grant_revoked joins the lifecycle vocabulary (#211 delete-to-pending
-- revocation, decided 2026-07-27). The value is not used inside this
-- migration, so adding it within the migration transaction is safe.
ALTER TYPE "PluginLifecycleEventType" ADD VALUE 'GrantRevoked';

-- AlterTable
-- NOT NULL without a default is deliberate and safe: no grant writer existed
-- before Phase C1 (PluginGrantService is introduced alongside this
-- migration), so plugin_grants is empty on every deployment.
ALTER TABLE "plugin_grants" ADD COLUMN "decided_risk_level" "RiskLevel" NOT NULL;

-- CreateTable
CREATE TABLE "plugin_permissions" (
    "id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "risk_level" "RiskLevel" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plugin_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plugin_permissions_slug_key" ON "plugin_permissions"("slug");

-- CreateIndex
CREATE INDEX "plugin_permissions_plugin_id_idx" ON "plugin_permissions"("plugin_id");

-- AddForeignKey
ALTER TABLE "plugin_permissions" ADD CONSTRAINT "plugin_permissions_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
