-- A plugin load record names the install it loaded and says whether the load
-- completed (#1083), so a process that doesn't load a plugin can tell whether
-- a running process of the process role that does has this install of it
-- ready: the gateway worker before it routes to the coordinator, and the api
-- when a plugin is switched on. The lookup goes by slug and process role,
-- which no index covered.
--
-- The rows belong to running processes, which write them again at their next
-- start, and nothing is deployed, so the table is emptied rather than
-- backfilled.
DELETE FROM "plugin_process_loads";

-- AlterTable
ALTER TABLE "plugin_process_loads" ADD COLUMN     "installed_at" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "ready" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "plugin_process_loads_slug_process_role_idx" ON "plugin_process_loads"("slug", "process_role");
