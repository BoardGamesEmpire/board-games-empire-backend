-- FetchGames: several external IDs in one call, with the most a DataGateway takes (#925).
ALTER TYPE "data_gateway_capabilities" ADD VALUE 'FetchGames';
ALTER TABLE "data_gateways" ADD COLUMN "fetch_games_max_ids" INTEGER;
