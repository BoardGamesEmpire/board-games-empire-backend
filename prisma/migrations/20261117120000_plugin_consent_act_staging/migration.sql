-- A consent act records the staged update it answered, so rejecting that staging deletes exactly its pre-consents (#1152). Nullable: an act on the active manifest answered no staging. No database holds a plugin row, so there is nothing to backfill.
ALTER TABLE "plugin_consent_acts" ADD COLUMN "staging_id" TEXT;
