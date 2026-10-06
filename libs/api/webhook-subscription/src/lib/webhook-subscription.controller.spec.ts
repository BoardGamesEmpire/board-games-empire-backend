import { DatabaseModule } from '@bge/database';
import { AbilityService, PoliciesGuard } from '@bge/permissions';
import { EncryptionService } from '@bge/services';
import { createMockAbilityService, createTestingModuleWithDb } from '@bge/testing';
import { WebhooksModule } from '@bge/webhooks';
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
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(WebhookSubscriptionController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
