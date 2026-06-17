import { DatabaseModule } from '@bge/database';
import { SecureHttpModule } from '@bge/secure-http';
import { ServicesModule } from '@bge/services';
import { WebhooksModule } from '@bge/webhooks';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { WEBHOOK_QUEUE_NAME } from '../constants/webhook-queue.constants';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import { WebhookDeliveryService } from './webhook-delivery.service';

/**
 * Consumer end of the webhook delivery queue. Imported by the worker app only.
 * Registering the same queue name here attaches the BullMQ worker; the producer
 * module (API side) registers it for enqueue. The global `WebhooksModule`
 * supplies the signer; `ServicesModule` supplies `EncryptionService` to decrypt
 * the at-rest secret before signing.
 *
 * SecureHttpModule supplies the SSRF-guarded client every delivery POSTs
 * through — webhook URLs are user-supplied, so they must never bypass it.
 */
@Module({
  imports: [
    DatabaseModule,
    SecureHttpModule,
    ServicesModule,
    WebhooksModule,
    BullModule.registerQueue({ name: WEBHOOK_QUEUE_NAME }),
  ],
  providers: [WebhookDeliveryService, WebhookDeliveryProcessor],
  exports: [WebhookDeliveryService],
})
export class WebhookQueueConsumerModule {}
