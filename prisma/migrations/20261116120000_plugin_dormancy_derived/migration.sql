-- Dormancy is worked out when read (#1151): whether a household's plugin unit
-- can run follows from the active manifest's scope and the unit's retained
-- configuration, so nothing records a unit going dormant or coming back.

-- Pre-alpha: rows of the removed kinds are dropped, not backfilled.
DELETE FROM "plugin_lifecycle_events" WHERE "event" IN ('UnitDormant', 'UnitRevived');

-- AlterEnum
BEGIN;
CREATE TYPE "PluginLifecycleEventType_new" AS ENUM ('Installed', 'Enabled', 'Disabled', 'Uninstalled', 'ConfigUpdated', 'UpdateCheckCompleted', 'UpdatePending', 'UpdateApproved', 'UpdateRejected', 'LoadFailed', 'GrantCreated', 'GrantRejected', 'GrantRevoked', 'ReconsentRequested');
ALTER TABLE "plugin_lifecycle_events" ALTER COLUMN "event" TYPE "PluginLifecycleEventType_new" USING ("event"::text::"PluginLifecycleEventType_new");
ALTER TYPE "PluginLifecycleEventType" RENAME TO "PluginLifecycleEventType_old";
ALTER TYPE "PluginLifecycleEventType_new" RENAME TO "PluginLifecycleEventType";
DROP TYPE "public"."PluginLifecycleEventType_old";
COMMIT;

-- AlterTable
ALTER TABLE "household_plugins" DROP COLUMN "dormant_at",
DROP COLUMN "dormant_reason";

-- DropEnum
DROP TYPE "PluginUnitDormantReason";
