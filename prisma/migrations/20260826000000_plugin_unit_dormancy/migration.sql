-- #369 (D-CK–D-CP on #59): dormancy for retained household enablement rows.
--
-- A `HouseholdPlugin` row can outlive the conditions that made it legal: an
-- activation re-scopes the plugin household→server and the row's surface stops
-- existing (#369), or it tightens `config.schema` and the retained document
-- stops conforming (#370). The row is RETAINED either way — the same argument
-- uninstall's tombstone makes, so a re-scope back or a conforming document
-- restores the household's settings — and dormancy is what keeps anything from
-- serving it meanwhile.
--
-- Single-valued with a precedence (D-CP): one activation can do both, and
-- ScopeOrphaned outranks NeedsConfiguration because config cannot heal a
-- surface that no longer exists.
--
-- No backfill. Pre-alpha, nothing is deployed, so there are no orphaned rows
-- in the wild; the reconciliation is go-forward only and runs in activation.

-- CreateEnum
CREATE TYPE "PluginUnitDormantReason" AS ENUM ('ScopeOrphaned', 'NeedsConfiguration');

-- AlterTable
ALTER TABLE "household_plugins"
  ADD COLUMN "dormant_reason" "PluginUnitDormantReason",
  ADD COLUMN "dormant_at" TIMESTAMPTZ(3);

-- AlterEnum
-- Two lifecycle kinds rather than reuse of UnitDisabled: that event means
-- consent suspension and carries the escalated permission slugs as its durable
-- "why". A dormancy row has no slugs and a different cause, so recording it
-- under the same kind would make the provenance table lie about both.
ALTER TYPE "PluginLifecycleEventType" ADD VALUE 'UnitDormant';
ALTER TYPE "PluginLifecycleEventType" ADD VALUE 'UnitRevived';
