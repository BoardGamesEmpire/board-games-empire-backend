/*
  Warnings:

  - You are about to drop the column `user_id` on the `apikeys` table. All the data in the column will be lost.
  - Added the required column `reference_id` to the `apikeys` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "apikeys" DROP CONSTRAINT "apikeys_user_id_fkey";

-- DropIndex
DROP INDEX "apikeys_user_id_idx";

-- AlterTable
ALTER TABLE "apikeys" DROP COLUMN "user_id",
ADD COLUMN     "config_id" TEXT NOT NULL DEFAULT 'default',
ADD COLUMN     "permissions" TEXT,
ADD COLUMN     "reference_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "two_factor" ADD COLUMN     "verified" BOOLEAN DEFAULT true;

-- CreateIndex
CREATE INDEX "apikeys_config_id_idx" ON "apikeys"("config_id");

-- CreateIndex
CREATE INDEX "apikeys_reference_id_idx" ON "apikeys"("reference_id");
