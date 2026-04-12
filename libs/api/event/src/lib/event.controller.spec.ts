import { Event } from '@bge/database';
import { AppAbility, PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb, makeEvent } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import type { ClsService } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventController } from './event.controller';
import { EventService } from './event.service';

describe('EventController', () => {
  let controller: EventController;
  let service: jest.Mocked<
    Pick<EventService, 'getEvents' | 'getEventById' | 'createEvent' | 'updateEvent' | 'deleteEvent'>
  >;
  let cls: jest.Mocked<ClsService>;

  const mockUserAbility = { rules: [] } as unknown as AppAbility;
  const mockApiKeyAbility = { rules: [] } as unknown as AppAbility;

  beforeEach(async () => {
    service = {
      getEvents: jest.fn(),
      getEventById: jest.fn(),
      createEvent: jest.fn(),
      updateEvent: jest.fn(),
      deleteEvent: jest.fn(),
    } satisfies Partial<jest.Mocked<EventService>>;

    const { module, cls: mockCls } = await createTestingModuleWithDb({
      controllers: [EventController],
      providers: [
        { provide: EventService, useValue: service },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(EventController);
    cls = mockCls;

    cls.get.mockImplementation((key: unknown) => {
      if (key === 'userAbility') return mockUserAbility;
      if (key === 'apiKeyAbility') return mockApiKeyAbility;
      return undefined;
    });
  });

  afterEach(() => jest.clearAllMocks());

  describe('getEvents', () => {
    it('delegates to EventService.getEvents with abilities and wraps response', async () => {
      const events = [stubEvent(), stubEvent()];
      service.getEvents.mockResolvedValue(events);

      const result = await firstValueFrom(controller.getEvents({ limit: 10, offset: 0 }));

      expect(service.getEvents).toHaveBeenCalledWith({ limit: 10, offset: 0 }, [mockUserAbility, mockApiKeyAbility]);
      expect(result).toEqual({ events });
    });

    it('retrieves abilities from CLS', async () => {
      service.getEvents.mockResolvedValue([]);

      await firstValueFrom(controller.getEvents({ limit: 10, offset: 0 }));

      expect(cls.get).toHaveBeenCalledWith('userAbility');
      expect(cls.get).toHaveBeenCalledWith('apiKeyAbility');
    });
  });

  describe('getEventById', () => {
    it('delegates to EventService.getEventById and wraps response', async () => {
      const event = stubEvent({ id: 'ev-42' });
      service.getEventById.mockResolvedValue(event);

      const result = await firstValueFrom(controller.getEventById('ev-42'));

      expect(service.getEventById).toHaveBeenCalledWith('ev-42', [mockUserAbility, mockApiKeyAbility]);
      expect(result).toEqual({ event });
    });
  });

  describe('createEvent', () => {
    it('delegates to EventService.createEvent with userId and abilities', async () => {
      const created = stubEvent({ id: 'new-1', title: 'Game Night' });
      service.createEvent.mockResolvedValue(created);

      const dto: CreateEventDto = { title: 'Game Night' } as CreateEventDto;
      const result = await firstValueFrom(controller.createEvent(makeSession('user-42'), dto));

      expect(service.createEvent).toHaveBeenCalledWith('user-42', dto);
      expect(result).toEqual({
        message: 'Event created successfully',
        event: created,
      });
    });
  });

  describe('updateEvent', () => {
    it('delegates to EventService.updateEvent and wraps response', async () => {
      const updated = stubEvent({ id: 'ev-1', title: 'Updated' });
      service.updateEvent.mockResolvedValue(updated);

      const dto: UpdateEventDto = { title: 'Updated' };
      const result = await firstValueFrom(controller.updateEvent('ev-1', dto));

      expect(service.updateEvent).toHaveBeenCalledWith('ev-1', dto, [mockUserAbility, mockApiKeyAbility]);
      expect(result).toEqual({
        message: 'Event with ID ev-1 updated successfully',
        event: updated,
      });
    });
  });

  describe('deleteEvent', () => {
    it('delegates to EventService.deleteEvent with userId', async () => {
      const deleted = stubEvent({ id: 'ev-del' });
      service.deleteEvent.mockResolvedValue(deleted);

      const result = await firstValueFrom(controller.deleteEvent('ev-del', makeSession('user-del')));

      expect(service.deleteEvent).toHaveBeenCalledWith('ev-del', 'user-del', [mockUserAbility, mockApiKeyAbility]);
      expect(result).toEqual({
        message: 'Event with ID ev-del deleted successfully',
        event: deleted,
      });
    });
  });
});

function stubEvent(overrides: Partial<Event> = {}): Event {
  return makeEvent({
    householdId: 'household-1',
    createdById: 'user-1',
    ...overrides,
  });
}

function makeSession(userId = 'user-1') {
  return { user: { id: userId } } as UserSession;
}
