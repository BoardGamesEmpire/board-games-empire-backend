-- Every consent decision is written by a consent act (#1336). No database holds a plugin row, so there is nothing to backfill.
ALTER TABLE "plugin_grants" ALTER COLUMN "act_id" SET NOT NULL;
