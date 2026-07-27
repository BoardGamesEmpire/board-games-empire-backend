-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('Low', 'Medium', 'High', 'Critical');

-- AlterTable
ALTER TABLE "permissions" ADD COLUMN     "risk_level" "RiskLevel" NOT NULL DEFAULT 'Low';
