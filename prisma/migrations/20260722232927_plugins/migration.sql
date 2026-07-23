-- CreateEnum
CREATE TYPE "PluginCategory" AS ENUM ('DataGateway', 'NotificationChannel', 'StorageDriver', 'MediaIntegration', 'FeedbackSink', 'AnalyticsSink', 'Observability', 'BackupSink', 'CalendarSync', 'RecommendationEngine', 'EventHook');

-- CreateEnum
CREATE TYPE "PluginExecutionMode" AS ENUM ('InProcess', 'Worker');

-- CreateEnum
CREATE TYPE "PluginGrantScope" AS ENUM ('Server', 'Household', 'User');

-- CreateEnum
CREATE TYPE "PluginGrantStatus" AS ENUM ('Granted', 'Denied');

-- CreateEnum
CREATE TYPE "PluginLifecycleEventType" AS ENUM ('Installed', 'Enabled', 'Disabled', 'Uninstalled', 'ConfigUpdated', 'UpdateCheckCompleted', 'UpdatePending', 'UpdateApproved', 'UpdateRejected', 'LoadFailed', 'GrantCreated', 'GrantRejected', 'UnitDisabled');

-- CreateEnum
CREATE TYPE "PluginScope" AS ENUM ('Server', 'Household');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "resource_types" ADD VALUE 'Plugin';
ALTER TYPE "resource_types" ADD VALUE 'PluginGrant';
ALTER TYPE "resource_types" ADD VALUE 'HouseholdPlugin';
ALTER TYPE "resource_types" ADD VALUE 'PluginLifecycleEvent';

-- CreateTable
CREATE TABLE "household_plugins" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "household_plugins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_grants" (
    "id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "scope_type" "PluginGrantScope" NOT NULL,
    "scope_id" TEXT NOT NULL DEFAULT '',
    "permission_slug" TEXT NOT NULL,
    "status" "PluginGrantStatus" NOT NULL,
    "decided_by_id" TEXT,
    "manifest_version" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plugin_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugin_lifecycle_events" (
    "id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "plugin_slug" TEXT NOT NULL,
    "event" "PluginLifecycleEventType" NOT NULL,
    "actor" JSONB NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "correlation_id" TEXT,
    "manifest_version" TEXT,
    "scope_type" "PluginGrantScope",
    "scope_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plugins" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "category" "PluginCategory" NOT NULL,
    "scope" "PluginScope" NOT NULL,
    "execution_mode" "PluginExecutionMode" NOT NULL DEFAULT 'InProcess',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "bundled" BOOLEAN NOT NULL DEFAULT false,
    "installed_from_url" TEXT,
    "installed_sha256" TEXT,
    "registry_slug" TEXT,
    "manifest_json" JSONB NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "load_failed" BOOLEAN NOT NULL DEFAULT false,
    "load_error" TEXT,
    "installed_by_id" TEXT,
    "installed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_check_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_update_check_at" TIMESTAMPTZ(3),
    "latest_known_version" TEXT,
    "latest_known_channel" TEXT,
    "security_advisory" TEXT,
    "pending_version" TEXT,
    "pending_manifest_json" JSONB,
    "pending_sha256" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plugins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "household_plugins_plugin_id_idx" ON "household_plugins"("plugin_id");

-- CreateIndex
CREATE UNIQUE INDEX "household_plugins_household_id_plugin_id_key" ON "household_plugins"("household_id", "plugin_id");

-- CreateIndex
CREATE INDEX "plugin_grants_plugin_id_scope_type_scope_id_idx" ON "plugin_grants"("plugin_id", "scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_grants_plugin_id_scope_type_scope_id_permission_slug_key" ON "plugin_grants"("plugin_id", "scope_type", "scope_id", "permission_slug");

-- CreateIndex
CREATE INDEX "plugin_lifecycle_events_plugin_id_occurred_at_idx" ON "plugin_lifecycle_events"("plugin_id", "occurred_at");

-- CreateIndex
CREATE INDEX "plugin_lifecycle_events_event_occurred_at_idx" ON "plugin_lifecycle_events"("event", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "plugins_slug_key" ON "plugins"("slug");

-- CreateIndex
CREATE INDEX "plugins_category_enabled_idx" ON "plugins"("category", "enabled");

-- CreateIndex
CREATE INDEX "plugins_load_failed_idx" ON "plugins"("load_failed");

-- CheckConstraint
-- Enforces the empty-string scope_id sentinel is reserved for Server-scope
-- rows only: Household/User grants must carry a real consent-unit id. Prisma
-- cannot express CHECK constraints in the schema, so it is added here by hand
-- (see prisma/models/plugin/plugin-grant.prisma). Pairs with the four-column
-- unique index above, which relies on the sentinel to enforce one Server row
-- per (plugin, permission).
ALTER TABLE "plugin_grants" ADD CONSTRAINT "plugin_grants_non_server_scope_id_not_empty" CHECK ("scope_type" = 'Server' OR "scope_id" <> '');

-- AddForeignKey
ALTER TABLE "household_plugins" ADD CONSTRAINT "household_plugins_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_grants" ADD CONSTRAINT "plugin_grants_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
