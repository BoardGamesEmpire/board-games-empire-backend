-- AlterTable
ALTER TABLE "households" ADD COLUMN "client_request_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "household_created_by_client_request_id_unique" ON "households"("created_by_id", "client_request_id");
