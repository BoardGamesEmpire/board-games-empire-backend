-- #1117: an installed checksum is 64 lowercase hex characters, the only form
-- the server writes and the only one it reads back. A row holding anything
-- else, which only a hand edit could write, fails here rather than at the
-- next read of the plugin inventory, which would refuse it for every plugin.

-- AlterTable
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_installed_sha256_format" CHECK ("installed_sha256" ~ '^[0-9a-f]{64}$');
