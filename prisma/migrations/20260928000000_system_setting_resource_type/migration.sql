-- #441: name the settings subject after the model it guards.
--
-- `System` was a resource type with no model behind it, so no grant could be
-- written for it and only the Owner could update the server's settings. It is
-- `SystemSetting` now, like every other row-backed resource type.
--
-- Written by hand as a rename. Left to itself, Prisma drops the old value by
-- recreating the type and casting every column that uses it: `resource_type`
-- on `api_key_scopes`, `user_permissions` and `webhook_subscriptions`, and
-- `subject_type` on `media_contributions`. A rename changes only the label,
-- so no column is touched, and the schema and migrations still show no
-- difference.

-- AlterEnum
ALTER TYPE "resource_types" RENAME VALUE 'System' TO 'SystemSetting';
