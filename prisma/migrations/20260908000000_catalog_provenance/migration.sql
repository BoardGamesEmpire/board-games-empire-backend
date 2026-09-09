-- #235: provenance for the permission catalog, and a tombstone for Permission.
--
-- The seed used to overwrite every Permission row on every run and only ever
-- ADD RolePermission rows (#232, defects 1 and 2). From here the catalog is
-- reconciled instead: `managed_by` says who owns a row. `System` rows converge
-- to the manifest shipped with this code; `Admin` rows are operator-modified
-- and are left alone, their drift reported; `Plugin` is reserved — nothing
-- writes it today, `PluginPermission` being its own table — and a `Plugin` row
-- whose slug the manifest also claims stops the reconcile before its first
-- write.
--
-- A System permission the manifest drops is RETIRED (`retired_at`), not
-- deleted. `role_permissions`, `user_permissions` and `api_key_scopes` all
-- reference it with RESTRICT semantics, so a delete would fail on the first
-- surviving grant, and a tombstone is reversible when the slug comes back:
-- the same row is revived rather than a second one inserted. A System
-- role_permission the manifest drops IS deleted — removing a slug from a
-- role's catalog list is how a grant is revoked.
--
-- `roles.is_system` goes: the seed wrote `true` on every row and nothing read
-- it (#429), so `managed_by = 'System'` is what every existing row meant.
-- #429's scope column is its own migration.
--
-- `managed_by` has NO default. The `DEFAULT 'System'` on each ADD COLUMN is
-- the backfill for the rows the seed wrote, and the next statement drops it,
-- so every later writer must name an owner — Prisma's create inputs make that
-- a compile error — and no row can be claimed by the reconciler by omission.

-- CreateEnum
CREATE TYPE "PermissionOwner" AS ENUM ('System', 'Admin', 'Plugin');

-- AlterTable
ALTER TABLE "permissions"
  ADD COLUMN "managed_by" "PermissionOwner" NOT NULL DEFAULT 'System',
  ADD COLUMN "retired_at" TIMESTAMPTZ(3);
ALTER TABLE "permissions" ALTER COLUMN "managed_by" DROP DEFAULT;

-- AlterTable
ALTER TABLE "role_permissions"
  ADD COLUMN "managed_by" "PermissionOwner" NOT NULL DEFAULT 'System';
ALTER TABLE "role_permissions" ALTER COLUMN "managed_by" DROP DEFAULT;

-- AlterTable
ALTER TABLE "roles"
  DROP COLUMN "is_system",
  ADD COLUMN "managed_by" "PermissionOwner" NOT NULL DEFAULT 'System';
ALTER TABLE "roles" ALTER COLUMN "managed_by" DROP DEFAULT;
