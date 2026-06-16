import { DatabaseModule } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { ServicesModule } from '@bge/services';
import { createTestingModuleWithDb } from '@bge/testing';
import { WebhooksModule } from '@bge/webhooks';
import { ConfigModule } from '@nestjs/config';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { WebhookSubscriptionController } from './webhook-subscription.controller';
import { WebhookSubscriptionService } from './webhook-subscription.service';

describe('WebhookSubscriptionController', () => {
  let controller: WebhookSubscriptionController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      imports: [DatabaseModule, WebhooksModule, ServicesModule, ConfigModule.forRoot({ isGlobal: true })],
      providers: [WebhookSubscriptionService],
      controllers: [WebhookSubscriptionController],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(WebhookSubscriptionController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
