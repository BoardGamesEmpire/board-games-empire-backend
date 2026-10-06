import { Event, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { PoliciesGuard } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createTestingModuleWithDb, makeEvent, paginationQuery } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsServiceManager } from 'nestjs-cls';
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
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(EventController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getEvents', () => {
    it('delegates to EventService.getEvents and wraps the rows in the paginated envelope', async () => {
      const events = [stubEvent(), stubEvent()];
      service.getEvents.mockResolvedValue({ rows: events, total: 2 });

      const pagination = paginationQuery({ limit: 10 });
      const result = await firstValueFrom(controller.getEvents(pagination));

      expect(service.getEvents).toHaveBeenCalledWith(pagination);
      expect(result).toEqual({
        events,
        pagination: { page: 1, limit: 10, total: 2, totalPages: 1, hasMore: false },
      });
    });

    // #372: the echoed paging describes the query the controller was handed, so
    // a deep page has to report itself as one — not as page 1 of the rows sent.
    it('echoes the requested page rather than the shape of the rows returned', async () => {
      service.getEvents.mockResolvedValue({ rows: [stubEvent()], total: 25 });

      const result = await firstValueFrom(controller.getEvents(paginationQuery({ page: 3, limit: 10 })));

      expect(result).toEqual(
        expect.objectContaining({
          pagination: { page: 3, limit: 10, total: 25, totalPages: 3, hasMore: false },
        }),
      );
    });

    // The service composes the `Event` scope; the envelope is where the guard
    // checks for it, under the resource type the handler passes. Built inside a
    // request with nothing composed, an `Event` envelope must fail. A handler
    // passing a type still in `PENDING_SCOPE_SWEEP` would pass here instead,
    // which switches the guard off for that route without a sound.
    //
    // The failure has to name `Event` itself. The three event lists left the
    // sweep together, so a handler passing a sibling's type fails here too, and
    // in a real request answers 500 because the service composed `Event`.
    it('builds its envelope under the Event scope guard', async () => {
      service.getEvents.mockResolvedValue({ rows: [], total: 0 });

      const envelope = ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.getEvents(paginationQuery({ limit: 10 }))),
      );

      await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
      await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.Event}'`);
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
        message: t('success.event.created'),
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
        message: t('success.event.updated', { id: 'ev-1' }),
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
        message: t('success.event.deleted', { id: 'ev-del' }),
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
