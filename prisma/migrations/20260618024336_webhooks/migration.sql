-- CreateEnum
CREATE TYPE "webhook_subscription_statuses" AS ENUM ('Active', 'Pending', 'Disabled', 'Failed', 'Revoked');

-- AlterEnum
ALTER TYPE "resource_types" ADD VALUE 'WebhookSubscription';

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" TEXT NOT NULL,
    "resource_type" "resource_types" NOT NULL,
    "resource_id" TEXT,
    "household_id" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "status" "webhook_subscription_statuses" NOT NULL DEFAULT 'Active',
    "created_by_id" TEXT NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_delivery_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscription_event_types" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscription_event_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_subscriptions_resource_type_status_idx" ON "webhook_subscriptions"("resource_type", "status");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_household_id_idx" ON "webhook_subscriptions"("household_id");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_created_by_id_idx" ON "webhook_subscriptions"("created_by_id");

-- CreateIndex
CREATE INDEX "webhook_subscription_event_types_event_type_idx" ON "webhook_subscription_event_types"("event_type");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_subscription_event_types_subscription_id_event_type_key" ON "webhook_subscription_event_types"("subscription_id", "event_type");

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_subscription_event_types" ADD CONSTRAINT "webhook_subscription_event_types_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
