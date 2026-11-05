-- #1076: asking the DataGateways during a game search is a grant of its own,
-- `read:game_search:data_gateways`, on a resource type with no table behind
-- it. A direct user permission or an API key scope names the resource type,
-- so the enum needs the value.

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'GameSearch';
