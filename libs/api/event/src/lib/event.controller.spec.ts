import { Event } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb, makeEvent } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
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

  beforeEach(async () => {
    service = {
      getEvents: jest.fn(),
      getEventById: jest.fn(),
      createEvent: jest.fn(),
      updateEvent: jest.fn(),
      deleteEvent: jest.fn(),
    } satisfies Partial<jest.Mocked<EventService>>;

    const { module } = await createTestingModuleWithDb({
      controllers: [EventController],
      providers: [
        { provide: EventService, useValue: service },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(EventController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getEvents', () => {
    it('delegates to EventService.getEvents and wraps response', async () => {
      const events = [stubEvent(), stubEvent()];
      service.getEvents.mockResolvedValue(events);

      const result = await firstValueFrom(controller.getEvents({ limit: 10, offset: 0 }));

      expect(service.getEvents).toHaveBeenCalledWith({ limit: 10, offset: 0 });
      expect(result).toEqual({ events });
    });
  });

  describe('getEventById', () => {
    it('delegates to EventService.getEventById and wraps response', async () => {
      const event = stubEvent({ id: 'ev-42' });
      service.getEventById.mockResolvedValue(event);

      const result = await firstValueFrom(controller.getEventById('ev-42'));

      expect(service.getEventById).toHaveBeenCalledWith('ev-42');
      expect(result).toEqual({ event });
    });
  });

  describe('createEvent', () => {
    it('delegates to EventService.createEvent with userId and abilities', async () => {
      const created = stubEvent({ id: 'new-1', title: 'Game Night' });
      service.createEvent.mockResolvedValue(created);

      const dto: CreateEventDto = { title: 'Game Night' } as CreateEventDto;
      const result = await firstValueFrom(controller.createEvent(dto));

      expect(service.createEvent).toHaveBeenCalledWith(dto);
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

      expect(service.updateEvent).toHaveBeenCalledWith('ev-1', dto);
      expect(result).toEqual({
        message: 'Event with ID ev-1 updated successfully',
        event: updated,
      });
    });
  });

  describe('deleteEvent', () => {
    it('delegates to EventService.deleteEvent', async () => {
      const deleted = stubEvent({ id: 'ev-del' });
      service.deleteEvent.mockResolvedValue(deleted);

      const result = await firstValueFrom(controller.deleteEvent('ev-del'));

      expect(service.deleteEvent).toHaveBeenCalledWith('ev-del');
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
