-- CreateEnum
CREATE TYPE "game_removal_reasons" AS ENUM ('Destroyed', 'Gifted', 'Lost', 'Other', 'Sold', 'Stolen', 'Traded');

-- AlterTable
ALTER TABLE "game_collections" ADD COLUMN     "delete_reason" "game_removal_reasons",
ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "visibility" "visibility_types" NOT NULL DEFAULT 'Private';
