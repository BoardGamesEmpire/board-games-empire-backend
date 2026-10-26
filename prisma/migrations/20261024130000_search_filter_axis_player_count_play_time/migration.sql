-- #869: player count and play time join publish year as search filters a
-- DataGateway can declare. Postgres can add an enum value inside the
-- migration's transaction, but can't use it there, and nothing here does.

-- AlterEnum
ALTER TYPE "search_filter_axes" ADD VALUE 'PlayerCount';

-- AlterEnum
ALTER TYPE "search_filter_axes" ADD VALUE 'PlayTime';
