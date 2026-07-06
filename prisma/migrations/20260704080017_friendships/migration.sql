-- CreateEnum
CREATE TYPE "friendship_statuses" AS ENUM ('Accepted', 'Blocked', 'Declined', 'Pending', 'Withdrawn');

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'Friendship';

-- AlterTable
ALTER TABLE "households" ADD COLUMN     "visibility" "visibility_types" NOT NULL DEFAULT 'Household';

-- CreateTable
CREATE TABLE "friendships" (
    "id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "addressee_id" TEXT NOT NULL,
    "status" "friendship_statuses" NOT NULL DEFAULT 'Pending',
    "message" TEXT,
    "pair_key" TEXT NOT NULL,
    "responded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "friendships_addressee_id_idx" ON "friendships"("addressee_id");

-- CreateIndex
CREATE INDEX "friendships_status_idx" ON "friendships"("status");

-- CreateIndex
CREATE UNIQUE INDEX "friendships_requester_id_addressee_id_key" ON "friendships"("requester_id", "addressee_id");

CREATE UNIQUE INDEX "friendships_pair_key_key" ON "friendships"("pair_key");

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
