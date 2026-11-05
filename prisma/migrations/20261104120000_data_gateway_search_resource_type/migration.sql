-- #1076: asking the DataGateways is a grant of its own,
-- `read:data_gateway:search`, on a resource type with no table behind it
-- (#1067 renamed it from `read:game_search:data_gateways` on `GameSearch`).
-- A direct user permission or an API key scope names the resource type, so
-- the enum needs the value.

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'DataGatewaySearch';
