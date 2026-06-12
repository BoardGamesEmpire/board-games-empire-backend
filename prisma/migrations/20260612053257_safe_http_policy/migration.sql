-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'SafeHttpPolicy';

-- CreateTable
CREATE TABLE "safe_http_policy" (
    "id" TEXT NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "default_timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "default_max_redirects" INTEGER NOT NULL DEFAULT 5,
    "strict_mode" BOOLEAN NOT NULL DEFAULT true,
    "allowed_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_cidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blocked_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blocked_cidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "safe_http_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "safe_http_policy_singleton_key" ON "safe_http_policy"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "safe_http_policy_identifier_key" ON "safe_http_policy"("identifier");
