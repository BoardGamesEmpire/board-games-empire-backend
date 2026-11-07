-- #497: the extended network. A rung of the reach ladder past friends of
-- friends, and the table its rules read: a row for each ordered pair of users
-- up to three accepted friendship steps apart, with the fewest steps between
-- them. A worker job writes the rows, not a request, so the migration leaves
-- the table empty and the worker's rebuild at start fills it.
--
-- A value `ADD VALUE` adds can't be used before its transaction commits, so
-- nothing here uses `ExtendedNetwork`.
--
-- Prisma cannot express CHECK constraints in the schema, so the two below are
-- written by hand: a row counts one to three steps, and no user is in their
-- own extended network.

-- AlterEnum
ALTER TYPE "reach_types" ADD VALUE 'ExtendedNetwork';

-- CreateTable
CREATE TABLE "extended_network" (
    "user_id" TEXT NOT NULL,
    "other_user_id" TEXT NOT NULL,
    "steps" INTEGER NOT NULL,

    CONSTRAINT "extended_network_pkey" PRIMARY KEY ("user_id","other_user_id"),
    CONSTRAINT "extended_network_steps_check" CHECK ("steps" BETWEEN 1 AND 3),
    CONSTRAINT "extended_network_not_self_check" CHECK ("user_id" <> "other_user_id")
);

-- CreateIndex
CREATE INDEX "extended_network_other_user_id_idx" ON "extended_network"("other_user_id");

-- AddForeignKey
ALTER TABLE "extended_network" ADD CONSTRAINT "extended_network_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extended_network" ADD CONSTRAINT "extended_network_other_user_id_fkey" FOREIGN KEY ("other_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
