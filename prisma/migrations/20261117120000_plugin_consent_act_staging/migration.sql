-- A consent act records the staged update it answered, so rejecting that staging deletes exactly its pre-consents (#1152). Nullable: an act on the active manifest answered no staging. No database holds a plugin row, so there is nothing to backfill.
ALTER TABLE "plugin_consent_acts" ADD COLUMN "staging_id" TEXT;

-- Rejecting a staging reads the acts that answered it, while it holds the plugin row; the unit-history index leads with the unit and cannot find them by staging.
CREATE INDEX "plugin_consent_acts_plugin_id_staging_id_idx" ON "plugin_consent_acts"("plugin_id", "staging_id");
