# @bge/bootstrap

The boot sequence every Postgres-connected process runs before its Nest application exists (#236): take the advisory lock, read `_prisma_migrations` against the migration manifest this build was generated from, then act on what it finds. The api, the one build with a migrator, applies pending migrations and runs the seeds; the worker and the two gateway processes only check the schema, and wait for the api when it is behind. Behaviour follows database state; there is no mode flag. See `docs/BOOTSTRAP.md`.
