-- #515: an import batch has exactly one base job, the one with no parent, and
-- GET /games/import now pages and counts batches by it. ON DELETE SET NULL
-- turned each expansion of a deleted base job into a base job too, so the
-- batch listed once per expansion and `total` counted each one. Deleting a
-- base job now deletes its expansions, so a batch goes as a whole.

-- DropForeignKey
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_parent_job_id_fkey";

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_fkey" FOREIGN KEY ("parent_job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
