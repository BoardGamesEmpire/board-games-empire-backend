-- #1016: better-auth 1.7 checks at boot that the schema holds what its plugins
-- use, and answers every /api/auth request with an error when it does not.
-- The two-factor plugin gained a failed-attempt count and a lockout time, and
-- the device authorization plugin now expects its two codes to be unique, which
-- the boot check does not flag.

-- AlterTable
ALTER TABLE "two_factor" ADD COLUMN     "failed_verification_count" INTEGER DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "device_codes_device_code_key" ON "device_codes"("device_code");

-- CreateIndex
CREATE UNIQUE INDEX "device_codes_user_code_key" ON "device_codes"("user_code");
