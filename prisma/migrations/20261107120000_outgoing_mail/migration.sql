-- (654): the mail settings, on the settings row, and the notification an admin
-- gets for a test email. The SMTP password is encrypted by the application
-- before it is written.

-- CreateEnum
CREATE TYPE "smtp_security_types" AS ENUM ('StartTls', 'ImplicitTls', 'None');

-- AlterEnum
ALTER TYPE "notification_types" ADD VALUE 'MailTestResult';

-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "mail_from_address" TEXT,
ADD COLUMN     "password_reset_link_lifetime_minutes" INTEGER NOT NULL DEFAULT 1440,
ADD COLUMN     "smtp_host" TEXT,
ADD COLUMN     "smtp_password" TEXT,
ADD COLUMN     "smtp_port" INTEGER NOT NULL DEFAULT 587,
ADD COLUMN     "smtp_security" "smtp_security_types" NOT NULL DEFAULT 'StartTls',
ADD COLUMN     "smtp_user" TEXT;

-- The PATCH bounds these two, and the constraints hold every other writer to
-- the same range: a seed, a script, or SQL. A link lifetime at or below zero
-- would expire every reset token as it is minted, and a port outside
-- 1..65535 can't be connected to. 15 and 10080 must match
-- PASSWORD_RESET_LINK_LIFETIME_MINUTES in
-- libs/api/system-settings/src/lib/dto/update-system-settings.dto.ts.
-- Prisma cannot express CHECK constraints in the schema, so they are written
-- here by hand.

-- CheckConstraint
ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_password_reset_link_lifetime_minutes_range"
  CHECK ("password_reset_link_lifetime_minutes" BETWEEN 15 AND 10080);

-- CheckConstraint
ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_smtp_port_range"
  CHECK ("smtp_port" BETWEEN 1 AND 65535);
