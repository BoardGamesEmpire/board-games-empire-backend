import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { WebhookEventRegistry } from './registry/webhook-event.registry';
import { WebhookSigner } from './signing/webhook-signer';
import { WebhookVisibilityService } from './visibility/webhook-visibility.service';

/**
 * Webhook-domain building blocks shared by producer, consumer, and API.
 * Visibility lives here (not the queue lib) because both the dispatch-time
 * audience check (producer) and the create-time scope check (API) need it, and
 * the API lib must not depend on the queue — shared is their only common
 * ancestor. Registry and signer stay dependency-free; visibility pulls in db.
 */
@Module({
  imports: [DatabaseModule],
  providers: [WebhookEventRegistry, WebhookSigner, WebhookVisibilityService],
  exports: [WebhookEventRegistry, WebhookSigner, WebhookVisibilityService],
})
export class WebhooksModule {}
