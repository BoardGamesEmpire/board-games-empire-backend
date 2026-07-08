-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'ImportFailed';

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'Job';

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "jobs_idempotency_key_key" ON "jobs"("idempotency_key");
