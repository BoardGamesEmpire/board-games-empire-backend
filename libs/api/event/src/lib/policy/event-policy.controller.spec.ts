import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb, makeEventPolicy } from '@bge/testing';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { EventPolicyController } from './event-policy.controller';
import { EventPolicyService } from './event-policy.service';

describe('EventPolicyController', () => {
  let controller: EventPolicyController;
  let service: jest.Mocked<Pick<EventPolicyService, 'updatePolicy'>>;

  beforeEach(async () => {
    service = { updatePolicy: jest.fn() };

    const { module } = await createTestingModuleWithDb({
      controllers: [EventPolicyController],
      providers: [{ provide: EventPolicyService, useValue: service }],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(EventPolicyController);
  });

  afterEach(() => jest.clearAllMocks());

  it('delegates the patch and answers with a message and the policy', async () => {
    const policy = makeEventPolicy('event-1');
    service.updatePolicy.mockResolvedValue(policy);
    const dto = { allowSpectators: false };

    const result = await firstValueFrom(controller.updatePolicy('event-1', dto));

    expect(service.updatePolicy).toHaveBeenCalledWith('event-1', dto);
    expect(result).toEqual({ message: t('success.event_policy.updated'), policy });
  });

  // Its own grant, not update:event, which an organizer holds without being
  // able to change the policy (#796).
  it('checks update on the event policy, not on the event (#796)', () => {
    const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, EventPolicyController.prototype.updatePolicy) as Array<
      (ability: AppAbility) => boolean
    >;
    const can = jest.fn().mockReturnValue(true);

    expect(handlers).toHaveLength(1);
    handlers[0]({ can } as unknown as AppAbility);

    expect(can.mock.calls).toEqual([[Action.update, ResourceType.EventPolicy]]);
  });
});
