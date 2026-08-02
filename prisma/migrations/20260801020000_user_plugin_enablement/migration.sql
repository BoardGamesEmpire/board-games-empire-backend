-- #225: uniform per-user plugin enablement (UserPlugin anchor)

-- CreateTable
CREATE TABLE "user_plugins" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "suspended_for_consent" BOOLEAN NOT NULL DEFAULT false,
    "suspended_at" TIMESTAMPTZ(3),
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_plugins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_plugins_plugin_id_idx" ON "user_plugins"("plugin_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_plugins_user_id_plugin_id_key" ON "user_plugins"("user_id", "plugin_id");

-- AddForeignKey
ALTER TABLE "user_plugins" ADD CONSTRAINT "user_plugins_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Users are HARD-deleted (no deletedAt on User), so this constraint is what
-- keeps enablement rows from dangling; the cascade also makes user-deletion
-- cleanup free rather than a step the deletion flow must remember (#211).
ALTER TABLE "user_plugins" ADD CONSTRAINT "user_plugins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterEnum: user-unit suspension events reuse the scope-generic
-- UnitDisabled/UnitEnabled lifecycle kinds; only the subject vocabulary grows.
ALTER TYPE "resource_types" ADD VALUE 'UserPlugin';
