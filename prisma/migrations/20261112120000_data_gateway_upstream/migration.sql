-- A DataGateway declares the upstream it draws from at its interview (#925).
CREATE TYPE "upstreams" AS ENUM ('BoardGameGeek', 'IGDB', 'Steam');
ALTER TABLE "data_gateways" ADD COLUMN "upstream" "upstreams";
