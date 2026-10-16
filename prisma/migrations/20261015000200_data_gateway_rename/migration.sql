-- #710: GameGateway is DataGateway now, the name the glossary gives it.
--
-- Written by hand as renames. Left to itself, Prisma drops `game_gateways`
-- and creates `data_gateways`, losing every row, and recreates the
-- `resource_types` type to drop the old value, casting every column that uses
-- it. Renames keep the rows and the foreign keys that point at the table, no
-- column changes type, and the schema and migrations still show no difference.

-- AlterEnum
ALTER TYPE "resource_types" RENAME VALUE 'GameGateway' TO 'DataGateway';

-- RenameTable
ALTER TABLE "game_gateways" RENAME TO "data_gateways";

-- RenamePrimaryKey
ALTER TABLE "data_gateways" RENAME CONSTRAINT "game_gateways_pkey" TO "data_gateways_pkey";

-- RenameForeignKey
ALTER TABLE "data_gateways" RENAME CONSTRAINT "game_gateways_created_by_id_fkey" TO "data_gateways_created_by_id_fkey";

-- RenameIndex
ALTER INDEX "game_gateways_name_key" RENAME TO "data_gateways_name_key";

-- The permission rows are renamed in place too, so they keep their ids, and
-- every grant that points at one carries over: role grants, user overrides
-- (denials included) and API key scopes. Left to the catalog sync, the old
-- slugs would be retired and new rows created, and only the catalog's own
-- role grants would move; anything else would stay on a retired row, which
-- confers nothing. A row an operator changed keeps its own fields, but names
-- the renamed subject. On a new database the table is still empty here, and
-- the catalog sync fills it after.
--
-- A plugin's consent decisions are not renamed. They name the slug the
-- plugin's manifest asks for, not a row, and that manifest still asks for the
-- old slug, which no longer exists, so the plugin's grant confers nothing
-- until it ships a manifest that names the new one. An update that does
-- asks for consent to that slug as a new permission.
UPDATE "permissions"
SET "slug" = replace("slug", ':game_gateway', ':data_gateway'), "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" IN ('read:game_gateway', 'create:game_gateway', 'update:game_gateway', 'delete:game_gateway');

UPDATE "permissions"
SET "subject" = 'DataGateway', "updated_at" = CURRENT_TIMESTAMP
WHERE "subject" = 'GameGateway';
