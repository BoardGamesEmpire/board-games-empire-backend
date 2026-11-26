-- #1231: a collection entry holds copies. Each copy has its own acquisition,
-- condition, edition and removal, and each change to an entry's rating is kept
-- as a rating change. The entry's `quantity` becomes the number of copies, and
-- its release moves to the copies. A loan names the copy lent.
--
-- Written by hand around the backfill. Left to itself, Prisma drops `quantity`
-- and `release_id` before anything reads them, and adds `loaned_games.copy_id`
-- as NOT NULL with no value to give an existing loan.
--
-- Existing data:
-- - each entry gets `quantity` copies, at least 1 and at most 100, with an
--   unknown acquisition date, recorded at the entry's `created_at`, and the
--   entry's release;
-- - a removed entry's copies are removed on its `deleted_at` date, at day
--   precision, with its reason;
-- - an entry with a rating gets one rating change, with an unknown date;
-- - a loan names its entry's first copy.
--
-- One transaction. Since Prisma 7.4, migrate deploy commits each statement on
-- its own (prisma/prisma#30640), and a failure after the backfill would leave
-- copies made and columns dropped, with a retry failing on the tables it
-- created. Only the CHECK constraints can fail, on data the api never writes
-- (a rating outside 1 to 10), and a failure here rolls everything back. Prisma
-- then reports "current transaction is aborted"; the statement that failed is
-- in the database's log.

BEGIN;

-- CreateEnum
CREATE TYPE "date_precisions" AS ENUM ('Day', 'Month', 'Year');

-- CreateTable
CREATE TABLE "collection_copies" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "release_id" TEXT,
    "condition" "game_conditions",
    "acquired_on" DATE,
    "acquired_on_precision" "date_precisions",
    "acquired_from" TEXT,
    "price_paid_amount" INTEGER,
    "price_paid_currency" CHAR(3),
    "current_value_amount" INTEGER,
    "current_value_currency" CHAR(3),
    "note" TEXT,
    "removed_at" TIMESTAMPTZ(3),
    "removed_on" DATE,
    "removed_on_precision" "date_precisions",
    "remove_reason" "game_removal_reasons",
    "retracted_at" TIMESTAMPTZ(3),
    "upstream_account_id" TEXT,
    "upstream_key" TEXT,
    "edited_by_user_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collection_copies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_rating_changes" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "rating" INTEGER,
    "occurred_on" DATE,
    "occurred_on_precision" "date_precisions",
    "retracted_at" TIMESTAMPTZ(3),
    "edited_by_user_at" TIMESTAMPTZ(3),
    "upstream_account_id" TEXT,
    "upstream_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collection_rating_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_copies_entry_id_idx" ON "collection_copies"("entry_id");

-- CreateIndex
CREATE INDEX "collection_copies_release_id_idx" ON "collection_copies"("release_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_copies_upstream_account_id_upstream_key_key" ON "collection_copies"("upstream_account_id", "upstream_key");

-- CreateIndex
CREATE INDEX "collection_rating_changes_entry_id_occurred_on_idx" ON "collection_rating_changes"("entry_id", "occurred_on");

-- CreateIndex
CREATE UNIQUE INDEX "collection_rating_changes_upstream_account_id_upstream_key_key" ON "collection_rating_changes"("upstream_account_id", "upstream_key");

-- AddForeignKey
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "game_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "game_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_upstream_account_id_fkey" FOREIGN KEY ("upstream_account_id") REFERENCES "upstream_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_rating_changes" ADD CONSTRAINT "collection_rating_changes_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "game_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_rating_changes" ADD CONSTRAINT "collection_rating_changes_upstream_account_id_fkey" FOREIGN KEY ("upstream_account_id") REFERENCES "upstream_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: each entry's copies, at most 100. The ids follow the md5
-- precedent of 20261106130000_plugin_staging_id. A live entry's copies are
-- owned; a removed entry's are removed with it, on its `deleted_at` day.
INSERT INTO "collection_copies" ("id", "entry_id", "release_id", "removed_at", "removed_on", "removed_on_precision", "remove_reason", "created_at", "updated_at")
SELECT md5(random()::text || gc."id" || n::text), gc."id", gc."release_id", gc."deleted_at",
       CASE WHEN gc."deleted_at" IS NULL THEN NULL ELSE (gc."deleted_at" AT TIME ZONE 'UTC')::date END,
       CASE WHEN gc."deleted_at" IS NULL THEN NULL ELSE 'Day'::"date_precisions" END,
       CASE WHEN gc."deleted_at" IS NULL THEN NULL ELSE gc."delete_reason" END,
       gc."created_at", gc."created_at"
FROM "game_collections" AS gc
CROSS JOIN LATERAL generate_series(1, LEAST(GREATEST(gc."quantity", 1), 100)) AS n;

-- Backfill: the rating an entry has today, as one change with an unknown date.
INSERT INTO "collection_rating_changes" ("id", "entry_id", "rating", "created_at", "updated_at")
SELECT md5(random()::text || gc."id"), gc."id", gc."rating", gc."updated_at", gc."updated_at"
FROM "game_collections" AS gc
WHERE gc."rating" IS NOT NULL;

-- A loan names a copy: its entry's first.
ALTER TABLE "loaned_games" ADD COLUMN "copy_id" TEXT;

UPDATE "loaned_games" AS lg
SET "copy_id" = (
    SELECT cc."id"
    FROM "collection_copies" AS cc
    WHERE cc."entry_id" = lg."collection_id"
    ORDER BY cc."id"
    LIMIT 1
);

ALTER TABLE "loaned_games" ALTER COLUMN "copy_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "loaned_games_copy_id_idx" ON "loaned_games"("copy_id");

-- AddForeignKey
ALTER TABLE "loaned_games" ADD CONSTRAINT "loaned_games_copy_id_fkey" FOREIGN KEY ("copy_id") REFERENCES "collection_copies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "loaned_games" DROP CONSTRAINT "loaned_games_collection_id_fkey";

-- DropIndex
DROP INDEX "loaned_games_collection_id_idx";

-- AlterTable
ALTER TABLE "loaned_games" DROP COLUMN "collection_id";

-- The entry's quantity and release now live on its copies, and so does the
-- rule that a release belongs to the entry's platform game, which
-- 20260506055915_add_release_fks_and_integrity held on the entry with
-- `game_collections_release_match`. A copy names no platform game of its own,
-- so its trigger reads the entry's. The copies above took their entry's
-- release, which that trigger had already checked. That trigger also fired when
-- an entry's platform game changed; nothing writes that column, so the copy
-- trigger checks only the copy's own writes.
DROP TRIGGER "game_collections_release_match" ON "game_collections";

CREATE FUNCTION assert_collection_copy_release_matches_entry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.release_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM game_releases AS r
    JOIN game_collections AS gc ON gc.platform_game_id = r.platform_game_id
    WHERE r.id = NEW.release_id
      AND gc.id = NEW.entry_id
  ) THEN
    RAISE EXCEPTION
      'Integrity violation in %: release_id % does not belong to the platform game of entry %',
      TG_TABLE_NAME, NEW.release_id, NEW.entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collection_copies_release_match
  BEFORE INSERT OR UPDATE OF release_id, entry_id ON collection_copies
  FOR EACH ROW EXECUTE FUNCTION assert_collection_copy_release_matches_entry();

-- DropForeignKey
ALTER TABLE "game_collections" DROP CONSTRAINT "game_collections_release_id_fkey";

-- DropIndex
DROP INDEX "game_collections_release_id_idx";

-- AlterTable
ALTER TABLE "game_collections" DROP COLUMN "quantity",
DROP COLUMN "release_id";

-- A copy's money: an amount and its currency are given together or not at
-- all, and an amount is zero or more.
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_price_paid_pair" CHECK (("price_paid_amount" IS NULL) = ("price_paid_currency" IS NULL));
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_current_value_pair" CHECK (("current_value_amount" IS NULL) = ("current_value_currency" IS NULL));
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_price_paid_not_negative" CHECK ("price_paid_amount" >= 0);
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_current_value_not_negative" CHECK ("current_value_amount" >= 0);

-- A copy's dates: a date and its precision are set together.
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_acquired_on_precision_pair" CHECK (("acquired_on" IS NULL) = ("acquired_on_precision" IS NULL));
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_removed_on_precision_pair" CHECK (("removed_on" IS NULL) = ("removed_on_precision" IS NULL));

-- A removal date or reason belongs to a removed copy.
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_removal_needs_removed_at" CHECK ("removed_at" IS NOT NULL OR ("removed_on" IS NULL AND "remove_reason" IS NULL));

-- An upstream account needs the upstream's key. The key may outlive its
-- account, which is set to null when the account goes.
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_upstream_account_needs_key" CHECK ("upstream_account_id" IS NULL OR "upstream_key" IS NOT NULL);

-- A date is stored as the first day of its period: day 1 at Month, and
-- January 1 at Year.
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_acquired_on_period_start" CHECK (
    ("acquired_on_precision" IS DISTINCT FROM 'Month' OR extract(day FROM "acquired_on") = 1)
    AND ("acquired_on_precision" IS DISTINCT FROM 'Year' OR (extract(day FROM "acquired_on") = 1 AND extract(month FROM "acquired_on") = 1))
);
ALTER TABLE "collection_copies" ADD CONSTRAINT "collection_copies_removed_on_period_start" CHECK (
    ("removed_on_precision" IS DISTINCT FROM 'Month' OR extract(day FROM "removed_on") = 1)
    AND ("removed_on_precision" IS DISTINCT FROM 'Year' OR (extract(day FROM "removed_on") = 1 AND extract(month FROM "removed_on") = 1))
);

-- A rating change: a rating from 1 to 10, or none when the rating was
-- cleared, and its date on the same terms as a copy's.
ALTER TABLE "collection_rating_changes" ADD CONSTRAINT "collection_rating_changes_rating_range" CHECK ("rating" BETWEEN 1 AND 10);
ALTER TABLE "collection_rating_changes" ADD CONSTRAINT "collection_rating_changes_occurred_on_precision_pair" CHECK (("occurred_on" IS NULL) = ("occurred_on_precision" IS NULL));
ALTER TABLE "collection_rating_changes" ADD CONSTRAINT "collection_rating_changes_occurred_on_period_start" CHECK (
    ("occurred_on_precision" IS DISTINCT FROM 'Month' OR extract(day FROM "occurred_on") = 1)
    AND ("occurred_on_precision" IS DISTINCT FROM 'Year' OR (extract(day FROM "occurred_on") = 1 AND extract(month FROM "occurred_on") = 1))
);
ALTER TABLE "collection_rating_changes" ADD CONSTRAINT "collection_rating_changes_upstream_account_needs_key" CHECK ("upstream_account_id" IS NULL OR "upstream_key" IS NOT NULL);

COMMIT;
