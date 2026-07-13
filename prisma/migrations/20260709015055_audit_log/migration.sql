-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'AuditUnattributedEvent';

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'AuditLog';

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "audit_log_retention_days" INTEGER;

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "name" TEXT NOT NULL DEFAULT 'Board Games Empire';

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actor" JSONB NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "source" TEXT,
    "correlation_id" TEXT,
    "payload" JSONB NOT NULL,
    "initiated_at" TIMESTAMPTZ(3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_subject_subject_id_idx" ON "audit_logs"("subject", "subject_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_kind_occurred_at_idx" ON "audit_logs"("actor_kind", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_occurred_at_idx" ON "audit_logs"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_deleted_at_occurred_at_idx" ON "audit_logs"("deleted_at", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_correlation_id_idx" ON "audit_logs"("correlation_id");

-- CreateIndex
CREATE INDEX "audit_logs_event_occurred_at_idx" ON "audit_logs"("event", "occurred_at");
