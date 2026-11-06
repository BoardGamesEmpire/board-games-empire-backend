-- CreateTable
CREATE TABLE IF NOT EXISTS "plugin_artifacts" (
    "sha256" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "compressed_bytes" INTEGER NOT NULL,
    "url" TEXT,
    "registry_slug" TEXT,
    "received_by_id" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plugin_artifacts_pkey" PRIMARY KEY ("sha256")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "plugin_artifacts_expires_at_idx" ON "plugin_artifacts"("expires_at");
