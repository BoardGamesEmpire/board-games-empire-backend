-- CreateTable
CREATE TABLE IF NOT EXISTS "plugin_process_loads" (
    "process_id" TEXT NOT NULL,
    "process_role" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "loaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_process_loads_pkey" PRIMARY KEY ("process_id","slug")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "plugin_process_loads_heartbeat_at_idx" ON "plugin_process_loads"("heartbeat_at");
