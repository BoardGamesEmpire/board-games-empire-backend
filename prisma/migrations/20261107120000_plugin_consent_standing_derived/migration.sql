-- Consent standing is derived at read time (#1149): what a unit still owes
-- is worked out when read from its grants, the active manifest and the
-- catalog; serving depends only on the switches and dormancy. So the stored
-- suspension (suspended_for_consent, suspended_at) and the unit enable/disable
-- lifecycle events that maintained it are removed. This
-- removes bugs #1061, #1063 and #1147. ReconsentRequested replaces them as
-- the event that records an update asking for consent again.

-- Pre-alpha: rows of the removed kinds are dropped, not backfilled. Postgres
-- cannot cast a row holding a removed enum member, so they go first.
DELETE FROM "plugin_lifecycle_events" WHERE "event" IN ('UnitDisabled', 'UnitEnabled');

-- AlterEnum
BEGIN;
CREATE TYPE "PluginLifecycleEventType_new" AS ENUM ('Installed', 'Enabled', 'Disabled', 'Uninstalled', 'ConfigUpdated', 'UpdateCheckCompleted', 'UpdatePending', 'UpdateApproved', 'UpdateRejected', 'LoadFailed', 'GrantCreated', 'GrantRejected', 'GrantRevoked', 'ReconsentRequested', 'UnitDormant', 'UnitRevived');
ALTER TABLE "plugin_lifecycle_events" ALTER COLUMN "event" TYPE "PluginLifecycleEventType_new" USING ("event"::text::"PluginLifecycleEventType_new");
ALTER TYPE "PluginLifecycleEventType" RENAME TO "PluginLifecycleEventType_old";
ALTER TYPE "PluginLifecycleEventType_new" RENAME TO "PluginLifecycleEventType";
DROP TYPE "public"."PluginLifecycleEventType_old";
COMMIT;

-- AlterTable
ALTER TABLE "household_plugins" DROP COLUMN "suspended_at",
DROP COLUMN "suspended_for_consent";

-- AlterTable
ALTER TABLE "user_plugins" DROP COLUMN "suspended_at",
DROP COLUMN "suspended_for_consent";
