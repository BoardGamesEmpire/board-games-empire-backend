-- #696: no plugin ships inside the server, so every plugin row runs an artifact
-- and carries its checksum. A row without one fails here rather than being guessed at.
--
-- The statement that can fail runs first. Since Prisma 7.4, migrate deploy
-- commits each statement on its own (prisma/prisma#30640), so a failure after
-- the DROP would leave "bundled" gone and the retry failing on it. In this
-- order, a failure changes nothing, and a retry after a partial apply succeeds,
-- because SET NOT NULL on a column that is already NOT NULL does nothing. An
-- explicit BEGIN/COMMIT would also roll back, but Prisma then reports
-- "current transaction is aborted" instead of the null checksum.

-- AlterTable
ALTER TABLE "plugins" ALTER COLUMN "installed_sha256" SET NOT NULL;
ALTER TABLE "plugins" DROP COLUMN "bundled";
