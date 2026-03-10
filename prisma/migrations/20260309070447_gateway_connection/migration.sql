/*
  Warnings:

  - You are about to drop the column `base_url` on the `game_gateways` table. All the data in the column will be lost.
  - Added the required column `connection_port` to the `game_gateways` table without a default value. This is not possible if the table is not empty.
  - Added the required column `connection_url` to the `game_gateways` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "game_gateways" DROP COLUMN "base_url",
ADD COLUMN     "api_base_url" TEXT,
ADD COLUMN     "connection_port" INTEGER NOT NULL,
ADD COLUMN     "connection_url" TEXT NOT NULL;

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'GameGateway';

-- AlterTable
ALTER TABLE "game_gateways" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "games" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);
