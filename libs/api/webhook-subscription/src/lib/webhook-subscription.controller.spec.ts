import { DatabaseModule } from '@bge/database';
import { AbilityService, PoliciesGuard } from '@bge/permissions';
import { EncryptionService } from '@bge/services';
import { createMockAbilityService, createTestingModuleWithDb } from '@bge/testing';
import { WebhooksModule } from '@bge/webhooks';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { WebhookSubscriptionController } from './webhook-subscription.controller';
import { WebhookSubscriptionService } from './webhook-subscription.service';

describe('WebhookSubscriptionController', () => {
  let controller: WebhookSubscriptionController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      imports: [DatabaseModule, WebhooksModule],
      providers: [
        WebhookSubscriptionService,
        {
          provide: EncryptionService,
          useValue: { encrypt: jest.fn(), decrypt: jest.fn() },
        },
        { provide: AbilityService, useValue: createMockAbilityService() },
      ],
      controllers: [WebhookSubscriptionController],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(WebhookSubscriptionController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
