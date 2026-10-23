-- #719: the filterable axes are search filters, not only coverage axes, and
-- publish year joins them. Platform type and content type are coverage, but
-- publish year isn't, so the enum is renamed rather than given a sibling.
--
-- Written by hand around the rename. Left to itself, Prisma drops and recreates
-- the type, and with it every DataGateway's stored filterable axes. A renamed
-- type keeps them, and the column's default follows the type it names.

-- AlterEnum
ALTER TYPE "coverage_axes" RENAME TO "search_filter_axes";

-- AlterEnum
ALTER TYPE "search_filter_axes" ADD VALUE 'PublishYear';
