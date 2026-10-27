import { Action, EventStatus, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb, makeEvent } from '@bge/testing';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Http } from '@status/codes';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { EventLifecycleController } from './event-lifecycle.controller';
import { EventLifecycleService } from './event-lifecycle.service';

describe('EventLifecycleController', () => {
  let controller: EventLifecycleController;
  let service: jest.Mocked<Pick<EventLifecycleService, 'cancelEvent' | 'reopenEvent'>>;

  const event = { ...makeEvent({ id: 'event-1' }), status: EventStatus.Cancelled };

  beforeEach(async () => {
    service = {
      cancelEvent: jest.fn().mockResolvedValue(event),
      reopenEvent: jest.fn().mockResolvedValue(event),
    };

    const { module } = await createTestingModuleWithDb({
      controllers: [EventLifecycleController],
      providers: [{ provide: EventLifecycleService, useValue: service }],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(EventLifecycleController);
  });

  afterEach(() => jest.clearAllMocks());

  /** The one policy handler on `handler`, asked of an ability that records the question. */
  const askedBy = (handler: object) => {
    const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, handler) as Array<(ability: AppAbility) => boolean>;
    const can = jest.fn().mockReturnValue(true);

    expect(handlers).toHaveLength(1);
    handlers[0]({ can } as unknown as AppAbility);

    return can.mock.calls;
  };

  describe.each([
    ['cancel', EventLifecycleController.prototype.cancel],
    ['reopen', EventLifecycleController.prototype.reopen],
  ])('%s', (_, handler) => {
    // An action, not a create: it answers 200 (#620).
    it('answers 200 (#795)', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(Http.Ok);
    });

    // Naming the column is what keeps the edit grants out: they leave it out
    // of their fields, so an organizer passes PATCH and not this.
    it('asks for update on the event’s cancelledAt (#795)', () => {
      expect(askedBy(handler)).toEqual([[Action.update, ResourceType.Event, 'cancelledAt']]);
    });
  });

  it('cancels with the body’s reason and wraps the event (#795)', async () => {
    const result = await firstValueFrom(controller.cancel('event-1', { reason: 'rain' }));

    expect(service.cancelEvent).toHaveBeenCalledWith('event-1', { reason: 'rain' });
    expect(result).toEqual({ message: t('success.event.cancelled'), event });
  });

  it('reopens and wraps the event (#795)', async () => {
    const result = await firstValueFrom(controller.reopen('event-1'));

    expect(service.reopenEvent).toHaveBeenCalledWith('event-1');
    expect(result).toEqual({ message: t('success.event.reopened'), event });
  });
});
