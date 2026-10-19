-- #715: accepting a Pending language link resolves it again from what the
-- DataGateway supplied. The BCP 47 tag it sent beside an ISO code or a name
-- can name a script or region the codes can't (zh-Hant beside zho), so it's
-- kept with the other supplied values.

-- AlterTable
ALTER TABLE "language_gateway_links" ADD COLUMN     "supplied_ietf_tag" TEXT;
