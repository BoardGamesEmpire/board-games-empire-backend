-- #59 Phase C3: update consent state (D-AN/D-AO/D-AS/D-AT/D-AU)

-- AlterTable: staged-update timestamp, restart-required flag, uninstall tombstone
ALTER TABLE "plugins" ADD COLUMN "pending_since" TIMESTAMPTZ(3),
ADD COLUMN "restart_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "uninstalled_at" TIMESTAMPTZ(3);

-- AlterTable: per-household consent suspension (explicit state, `enabled` untouched by escalation)
ALTER TABLE "household_plugins" ADD COLUMN "suspended_for_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "suspended_at" TIMESTAMPTZ(3);

-- AlterEnum: late-acceptance re-enable event (symmetric with UnitDisabled)
ALTER TYPE "PluginLifecycleEventType" ADD VALUE 'UnitEnabled';
