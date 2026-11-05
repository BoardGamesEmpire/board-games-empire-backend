-- #357: a staging's identity is its own id, not its timestamp.
--
-- Since Prisma 7.4, migrate deploy commits each statement on its own
-- (prisma/prisma#30640). The constraint, the one statement that can fail,
-- needs the new column, so it cannot run first. Instead, the statements before
-- it are safe to repeat: a half-staged row fails here with the constraint's own
-- error, and once that row is fixed, a retry finishes the migration.

-- AlterTable
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "pending_staging_id" TEXT;
UPDATE "plugins" SET "pending_staging_id" = md5(random()::text || "id")
WHERE "pending_version" IS NOT NULL AND "pending_staging_id" IS NULL;

-- The staged-update columns are set and cleared as one set; a half-staged
-- row would make the guarded writes' predicates match the wrong staging.
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_staged_update_all_or_nothing" CHECK (
  ("pending_version" IS NULL AND "pending_manifest_json" IS NULL AND "pending_sha256" IS NULL
    AND "pending_since" IS NULL AND "pending_staging_id" IS NULL)
  OR
  ("pending_version" IS NOT NULL AND "pending_manifest_json" IS NOT NULL AND "pending_sha256" IS NOT NULL
    AND "pending_since" IS NOT NULL AND "pending_staging_id" IS NOT NULL)
);
