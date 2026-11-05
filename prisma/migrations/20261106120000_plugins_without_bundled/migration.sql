-- #696: no plugin ships inside the server, so every plugin row runs an artifact
-- and carries its checksum. A row without one fails here rather than being guessed at.

-- AlterTable
ALTER TABLE "plugins" DROP COLUMN "bundled";
ALTER TABLE "plugins" ALTER COLUMN "installed_sha256" SET NOT NULL;
