-- An unset ban flag counted as banned to some readers and not to others (#893),
-- so every NULL becomes false, the flag every reader takes as not banned.
-- A live write of a NULL flag is refused instead (BanFlagGate), since it is
-- an actor's mistake that can still be corrected. These rows are already
-- written, and sign-in and the permission checks, the readers that enforce a
-- ban, have always let their users in. false keeps that, even with a ban
-- reason set; true would lock them out on a guess.
UPDATE "users" SET "banned" = false WHERE "banned" IS NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "banned" SET NOT NULL;
