-- #236: the ledger of one-time data migrations.
--
-- `_prisma_migrations` records schema changes and nothing recorded data work,
-- so a backfill either re-ran with every seed or was run by hand and left no
-- trace. The api's boot sequence applies each entry of the registry in
-- `@bge/database` (`DATA_MIGRATIONS`) exactly once, under the bootstrap lock,
-- and writes its row here in the same transaction as the entry's own writes;
-- an applied entry whose code revision is above its row's refuses the boot,
-- having been edited after it ran, while one below its row's, a rollback, is
-- left to the newer build. The registry ships empty: the table exists so that
-- the first backfill has a ledger the day it is written, not the day after it
-- was needed.

-- CreateTable
CREATE TABLE "data_migrations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER NOT NULL,

    CONSTRAINT "data_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_migrations_name_key" ON "data_migrations"("name");
