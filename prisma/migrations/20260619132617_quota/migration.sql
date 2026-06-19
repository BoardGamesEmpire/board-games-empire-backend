-- CreateEnum
CREATE TYPE "quota_scopes" AS ENUM ('Server', 'Household', 'HouseholdMember', 'User');

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'Quota';

-- CreateTable
CREATE TABLE "quotas" (
    "id" TEXT NOT NULL,
    "scope" "quota_scopes" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "household_id" TEXT,
    "resource" TEXT NOT NULL,
    "description" TEXT,
    "created_by_id" TEXT,
    "updated_by_id" TEXT,
    "limit" BIGINT NOT NULL,
    "soft_overage" BOOLEAN NOT NULL DEFAULT false,
    "enforced" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotas_household_id_idx" ON "quotas"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotas_scope_scope_id_resource_key" ON "quotas"("scope", "scope_id", "resource");

-- AddForeignKey
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
