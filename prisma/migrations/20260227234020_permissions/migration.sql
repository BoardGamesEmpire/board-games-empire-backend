/*
  Warnings:

  - The values [FriendsOfHouseholds] on the enum `visibility_types` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `permissions` on the `apikeys` table. All the data in the column will be lost.
  - You are about to drop the column `role` on the `event_attendees` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `event_attendees` table. All the data in the column will be lost.
  - You are about to drop the column `allow_guest_invites` on the `events` table. All the data in the column will be lost.
  - You are about to drop the column `max_total_participants` on the `events` table. All the data in the column will be lost.
  - You are about to drop the column `strict_capacity` on the `events` table. All the data in the column will be lost.
  - You are about to drop the column `permission` on the `role_permissions` table. All the data in the column will be lost.
  - You are about to drop the column `permission` on the `user_permissions` table. All the data in the column will be lost.
  - You are about to drop the `event_member_permissions` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[role_id,permission_id]` on the table `role_permissions` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[user_id,permission_id,resource_type,resource_id]` on the table `user_permissions` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `permission_id` to the `role_permissions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `permission_id` to the `user_permissions` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "system_roles" AS ENUM ('Owner', 'Admin', 'Moderator', 'User', 'HouseholdOwner', 'HouseholdAdmin', 'HouseholdMember', 'HouseholdGuest', 'EventHost', 'EventCoHost', 'EventOrganizer', 'EventModerator', 'EventParticipant', 'EventGuest', 'EventSpectator');

-- CreateEnum
CREATE TYPE "actions" AS ENUM ('Create', 'Read', 'Update', 'Delete', 'Manage');

-- AlterEnum
BEGIN;
CREATE TYPE "visibility_types_new" AS ENUM ('Friends', 'FriendsOfFriends', 'Household', 'Private', 'Public');
ALTER TABLE "public"."events" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "public"."games" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "public"."media" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "public"."user_preferences" ALTER COLUMN "default_review_visibility" DROP DEFAULT;
ALTER TABLE "public"."user_profiles" ALTER COLUMN "visibility" DROP DEFAULT;
ALTER TABLE "events" ALTER COLUMN "visibility" TYPE "visibility_types_new" USING ("visibility"::text::"visibility_types_new");
ALTER TABLE "games" ALTER COLUMN "visibility" TYPE "visibility_types_new" USING ("visibility"::text::"visibility_types_new");
ALTER TABLE "media" ALTER COLUMN "visibility" TYPE "visibility_types_new" USING ("visibility"::text::"visibility_types_new");
ALTER TABLE "user_preferences" ALTER COLUMN "default_review_visibility" TYPE "visibility_types_new" USING ("default_review_visibility"::text::"visibility_types_new");
ALTER TABLE "user_profiles" ALTER COLUMN "visibility" TYPE "visibility_types_new" USING ("visibility"::text::"visibility_types_new");
ALTER TYPE "visibility_types" RENAME TO "visibility_types_old";
ALTER TYPE "visibility_types_new" RENAME TO "visibility_types";
DROP TYPE "public"."visibility_types_old";
ALTER TABLE "events" ALTER COLUMN "visibility" SET DEFAULT 'Friends';
ALTER TABLE "games" ALTER COLUMN "visibility" SET DEFAULT 'Public';
ALTER TABLE "media" ALTER COLUMN "visibility" SET DEFAULT 'Public';
ALTER TABLE "user_preferences" ALTER COLUMN "default_review_visibility" SET DEFAULT 'Private';
ALTER TABLE "user_profiles" ALTER COLUMN "visibility" SET DEFAULT 'Public';
COMMIT;

-- DropForeignKey
ALTER TABLE "event_member_permissions" DROP CONSTRAINT "event_member_permissions_event_id_fkey";

-- DropForeignKey
ALTER TABLE "event_member_permissions" DROP CONSTRAINT "event_member_permissions_granted_by_id_fkey";

-- DropForeignKey
ALTER TABLE "event_member_permissions" DROP CONSTRAINT "event_member_permissions_user_id_fkey";

-- DropIndex
DROP INDEX "role_permissions_role_id_permission_key";

-- DropIndex
DROP INDEX "user_permissions_permission_idx";

-- DropIndex
DROP INDEX "user_permissions_user_id_permission_resource_type_resource__key";

-- AlterTable
ALTER TABLE "apikeys" DROP COLUMN "permissions";

-- AlterTable
ALTER TABLE "event_attendees" DROP COLUMN "role",
DROP COLUMN "type";

-- AlterTable
ALTER TABLE "events" DROP COLUMN "allow_guest_invites",
DROP COLUMN "max_total_participants",
DROP COLUMN "strict_capacity";

-- AlterTable
ALTER TABLE "role_permissions" DROP COLUMN "permission",
ADD COLUMN     "permission_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "user_permissions" DROP COLUMN "permission",
ADD COLUMN     "inverted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "permission_id" TEXT NOT NULL;

-- DropTable
DROP TABLE "event_member_permissions";

-- DropEnum
DROP TYPE "SystemRole";

-- DropEnum
DROP TYPE "attendee_types";

-- DropEnum
DROP TYPE "event_participant_roles";

-- DropEnum
DROP TYPE "permissions";

-- CreateTable
CREATE TABLE "api_key_scopes" (
    "id" TEXT NOT NULL,
    "api_key_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "resource_type" "resource_types" NOT NULL,
    "resource_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_attendee_roles" (
    "id" TEXT NOT NULL,
    "event_attendee_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_attendee_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_policies" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "allow_member_invites" BOOLEAN NOT NULL DEFAULT true,
    "allow_guest_invites" BOOLEAN NOT NULL DEFAULT true,
    "max_attendees" INTEGER,
    "restrict_to_game_categories" BOOLEAN NOT NULL DEFAULT false,
    "require_host_approval" BOOLEAN NOT NULL DEFAULT false,
    "allow_spectators" BOOLEAN NOT NULL DEFAULT true,
    "max_total_participants" INTEGER,
    "strict_capacity" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_categories" (
    "id" TEXT NOT NULL,
    "event_policy_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "event_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "action" "actions" NOT NULL,
    "subject" TEXT NOT NULL,
    "fields" TEXT[],
    "conditions" JSONB,
    "inverted" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "api_key_scopes_permission_id_idx" ON "api_key_scopes"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_scopes_api_key_id_permission_id_resource_type_resou_key" ON "api_key_scopes"("api_key_id", "permission_id", "resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_attendee_roles_event_attendee_id_key" ON "event_attendee_roles"("event_attendee_id");

-- CreateIndex
CREATE INDEX "event_attendee_roles_role_id_idx" ON "event_attendee_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_attendee_roles_event_attendee_id_role_id_key" ON "event_attendee_roles"("event_attendee_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_policies_event_id_key" ON "event_policies"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_categories_event_policy_id_category_id_key" ON "event_categories"("event_policy_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_slug_key" ON "permissions"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "user_permissions_permission_id_idx" ON "user_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_permissions_user_id_permission_id_resource_type_resour_key" ON "user_permissions"("user_id", "permission_id", "resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "apikeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendee_roles" ADD CONSTRAINT "event_attendee_roles_event_attendee_id_fkey" FOREIGN KEY ("event_attendee_id") REFERENCES "event_attendees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendee_roles" ADD CONSTRAINT "event_attendee_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_policies" ADD CONSTRAINT "event_policies_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_event_policy_id_fkey" FOREIGN KEY ("event_policy_id") REFERENCES "event_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
