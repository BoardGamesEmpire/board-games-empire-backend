import { DatabaseModule } from '@bge/database';
import { PermissionsModule } from '@bge/permissions';
import { QuotaModule } from '@bge/quota';
import { ServicesModule } from '@bge/services';
import { WebhooksModule } from '@bge/webhooks';
import { Module } from '@nestjs/common';
import { WebhookSubscriptionController } from './webhook-subscription.controller';
import { WebhookSubscriptionService } from './webhook-subscription.service';

/**
 * HTTP/CRUD surface only. No queue dependency — CRUD never enqueues; only the
 * dispatcher (in @bge/queue-webhooks) does. The visibility check used at create
 * time comes from `WebhooksModule`; `ServicesModule` supplies
 * `EncryptionService` for at-rest secret encryption; `QuotaModule` supplies
 * the creator's webhook subscription quota (#1253).
 */
@Module({
  imports: [DatabaseModule, PermissionsModule, QuotaModule, ServicesModule, WebhooksModule],
  controllers: [WebhookSubscriptionController],
  providers: [WebhookSubscriptionService],
  exports: [WebhookSubscriptionService],
})
export class WebhookSubscriptionModule {}
