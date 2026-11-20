-- #935: a user's upstream account (their account at Steam, BoardGameGeek, ...)
-- replaces the never-used user_gateway_connections sketch. Nothing is deployed,
-- so the old tables are dropped, not migrated.
--
-- Hand-written in one way: Prisma cannot model a partial unique index, so
-- `upstream_accounts_verified_external_id` is deliberately absent from
-- `prisma/models/user/upstream-account.prisma`. It holds a verified external id
-- to one user; unverified rows are claims and may repeat.

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'UpstreamAccount';

-- DropTable
DROP TABLE "user_gateway_sync_logs";

-- DropTable
DROP TABLE "user_gateway_connections";

-- DropEnum
DROP TYPE "sync_directions";

-- CreateTable
CREATE TABLE "upstream_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "upstream" "upstreams" NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT,
    "profile_url" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "upstream_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upstream_account_sync_logs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "status" "sync_statuses" NOT NULL,
    "games_added" INTEGER NOT NULL DEFAULT 0,
    "games_updated" INTEGER NOT NULL DEFAULT 0,
    "games_removed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,

    CONSTRAINT "upstream_account_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "upstream_accounts_user_id_upstream_key" ON "upstream_accounts"("user_id", "upstream");

-- CreateIndex
CREATE INDEX "upstream_account_sync_logs_account_id_idx" ON "upstream_account_sync_logs"("account_id");

-- CreateIndex: hand-written, a verified external id belongs to one user.
CREATE UNIQUE INDEX "upstream_accounts_verified_external_id" ON "upstream_accounts"("upstream", "external_id") WHERE "verified";

-- AddForeignKey
ALTER TABLE "upstream_accounts" ADD CONSTRAINT "upstream_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upstream_account_sync_logs" ADD CONSTRAINT "upstream_account_sync_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "upstream_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
