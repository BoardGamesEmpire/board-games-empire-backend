-- Lists and a wishlist for every user (#1241): a list gets a kind, a reach, an
-- order and timestamps, and its entries (`game_lists`, renamed `list_entries`)
-- name a game or a platform game, with a position, a note and, on a wishlist, a
-- priority.
--
-- Hand-edited from what `prisma migrate dev --create-only` generated, in three
-- ways:
--
-- 1. `game_lists` is RENAMED to `list_entries`, with its primary key, indexes
--    and foreign keys renamed to the names Prisma expects, instead of being
--    dropped and recreated, so no row is lost. The old `priority` integer
--    (never written by any code) gives way to the `wishlist_priorities` enum
--    column, and the table's integrity trigger is renamed with it.
-- 2. `updated_at` columns are added with a default for existing rows, then the
--    default is dropped, because Prisma sets `@updatedAt` itself.
-- 3. The four rules below are written by hand, because Prisma cannot model a
--    CHECK constraint or a partial unique index, so they are deliberately
--    absent from `prisma/models/list`, on the precedent of
--    20261012000000_invite_outstanding_unique.
--    `apps/api-e2e/src/list/list-constraints.spec.ts` pins that all four exist.
--    No route meets the wishlist and name rules: no route writes `kind`, so
--    none can make a second wishlist, and the list service refuses a custom
--    list without a name itself (`LIST_NAME_REQUIRED`) before writing. The
--    release rule's first refusal comes from the renamed trigger (SQLSTATE
--    23503, free text), which runs before CHECK constraints, so its CHECK is a
--    backstop. The service validates the release rules, and the one-target
--    rule, itself before writing (#1241) rather than mapping any of those
--    database errors.

-- CreateEnum
CREATE TYPE "list_kinds" AS ENUM ('Custom', 'Wishlist');

-- CreateEnum
CREATE TYPE "wishlist_priorities" AS ENUM ('MustHave', 'LoveToHave', 'LikeToHave', 'ThinkingAboutIt', 'DontBuy');

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'List';

-- AlterTable: lists. The name stays on existing rows; a new list has none
-- unless it is given one.
ALTER TABLE "lists" ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "kind" "list_kinds" NOT NULL DEFAULT 'Custom',
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reach" "reach_types" NOT NULL DEFAULT 'Private',
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "name" DROP DEFAULT;

ALTER TABLE "lists" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "lists_user_id_position_idx" ON "lists"("user_id", "position");

-- RenameTable: the entries keep their rows, and a game list entry becomes a list entry.
ALTER TABLE "game_lists" RENAME TO "list_entries";

ALTER TABLE "list_entries" RENAME CONSTRAINT "game_lists_pkey" TO "list_entries_pkey";
ALTER INDEX "game_lists_platform_game_id_idx" RENAME TO "list_entries_platform_game_id_idx";
ALTER INDEX "game_lists_release_id_idx" RENAME TO "list_entries_release_id_idx";
ALTER TABLE "list_entries" RENAME CONSTRAINT "game_lists_list_id_fkey" TO "list_entries_list_id_fkey";
ALTER TABLE "list_entries" RENAME CONSTRAINT "game_lists_release_id_fkey" TO "list_entries_release_id_fkey";

-- Keeps refusing a release that isn't the named platform game's (see
-- 20260506055915_add_release_fks_and_integrity). It fires before the CHECK
-- below, so it is what a release without a platform game meets first.
ALTER TRIGGER "game_lists_release_match" ON "list_entries" RENAME TO "list_entries_release_match";

-- AlterTable: list_entries. `priority` was an unused integer.
ALTER TABLE "list_entries" DROP COLUMN "priority",
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "game_id" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priority" "wishlist_priorities",
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "platform_game_id" DROP NOT NULL;

ALTER TABLE "list_entries" ALTER COLUMN "updated_at" DROP DEFAULT;

-- The platform game's foreign key had no delete rule, so a list holding one
-- stopped Postgres deleting it. The entry now goes with it.
ALTER TABLE "list_entries" DROP CONSTRAINT "game_lists_platform_game_id_fkey";

-- CreateIndex
CREATE INDEX "list_entries_list_id_position_idx" ON "list_entries"("list_id", "position");

-- CreateIndex
CREATE INDEX "list_entries_game_id_idx" ON "list_entries"("game_id");

-- CreateIndex: NULLs are distinct, so each unique only bites its own kind of entry.
CREATE UNIQUE INDEX "list_entries_list_id_game_id_key" ON "list_entries"("list_id", "game_id");

-- CreateIndex
CREATE UNIQUE INDEX "list_entries_list_id_platform_game_id_key" ON "list_entries"("list_id", "platform_game_id");

-- AddForeignKey
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_platform_game_id_fkey" FOREIGN KEY ("platform_game_id") REFERENCES "platform_games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An entry names a game or a platform game, never both and never neither.
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_one_target" CHECK (num_nonnulls("game_id", "platform_game_id") = 1);

-- A release belongs to a platform game, so it can't sit on an entry that names a game.
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_release_needs_platform_game" CHECK ("release_id" IS NULL OR "platform_game_id" IS NOT NULL);

-- A custom list has a name. A wishlist may have none: a client shows its own
-- translated "Wishlist" for it.
ALTER TABLE "lists" ADD CONSTRAINT "lists_custom_needs_name" CHECK ("kind" = 'Wishlist' OR "name" IS NOT NULL);

-- A user has at most one wishlist, and any number of custom lists.
CREATE UNIQUE INDEX "lists_one_wishlist_per_user" ON "lists" ("user_id") WHERE "kind" = 'Wishlist';
