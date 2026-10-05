-- #571: hold the settings' day counts to the range their readers can act on.
--
-- Each reader turns a day count into a date. The feedback and audit sweeps
-- subtract a retention from now, and rejecting a media contribution adds the
-- reclaim window to it. Below one day a sweep deletes every row and a rejected
-- upload can no longer be reclaimed. Past about 2.4 million days the date falls
-- before 4713 BC, the earliest timestamp Postgres stores, and the reader
-- throws. The settings PATCH refuses both, and these constraints refuse them
-- from every other writer too: a seed, a script, or SQL.
--
-- 36500 is a century and must match MAX_DAYS in
-- libs/api/system-settings/src/lib/dto/update-system-settings.dto.ts. Null
-- still passes for the audit retention, where it means unlimited.
--
-- Prisma cannot express CHECK constraints in the schema, so they are written
-- here by hand (see prisma/models/system/system-setting.prisma).

-- CheckConstraint
ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_feedback_report_retention_days_range"
  CHECK ("feedback_report_retention_days" BETWEEN 1 AND 36500);

-- CheckConstraint
ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_contribution_reclaim_days_range"
  CHECK ("contribution_reclaim_days" BETWEEN 1 AND 36500);

-- CheckConstraint
ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_audit_log_retention_days_range"
  CHECK ("audit_log_retention_days" IS NULL OR "audit_log_retention_days" BETWEEN 1 AND 36500);
