-- #1117: a plugin artifact's checksum is 64 lowercase hex characters, the
-- only form the server writes and the only one it reads back, for the
-- installed artifact and the staged one alike. A row holding anything else,
-- which only a hand edit could write, fails here rather than at the next read:
-- the plugin inventory would refuse an installed one for every plugin, and
-- approval would refuse a staged one.

-- AlterTable
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_installed_sha256_format" CHECK ("installed_sha256" ~ '^[0-9a-f]{64}$');

-- AlterTable
-- A row with nothing staged holds null, which the check lets through.
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_pending_sha256_format" CHECK ("pending_sha256" ~ '^[0-9a-f]{64}$');
