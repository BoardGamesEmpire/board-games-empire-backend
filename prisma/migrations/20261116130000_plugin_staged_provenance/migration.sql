-- #1096: a staged update records where its artifact came from.
-- Every statement is safe to repeat (prisma/prisma#30640).
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "pending_from_url" TEXT;
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "pending_registry_slug" TEXT;

-- Both are null for an upload, so they cannot join the all-or-nothing set.
-- They may be set only while an update is staged.
ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "plugins_staged_provenance_needs_staging";
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_staged_provenance_needs_staging" CHECK (
  "pending_version" IS NOT NULL OR ("pending_from_url" IS NULL AND "pending_registry_slug" IS NULL)
);
