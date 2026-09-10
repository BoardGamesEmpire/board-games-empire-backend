# @bge/bootstrap

The boot sequence every Postgres-connected process runs before its Nest application exists (#236): take the advisory lock, read `_prisma_migrations` against the migration manifest this build was generated from, apply or wait, run the seeds, release. Behaviour follows database state; there is no mode flag. See `docs/BOOTSTRAP.md`.
