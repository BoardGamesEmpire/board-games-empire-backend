import { EventAttendee, EventAttendeeGameList, EventParticipationStatus, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { PoliciesGuard } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createTestingModuleWithDb, makeEventAttendee, paginationQuery } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { AddAttendeeDto } from './dto/add-attendee.dto';
import { UpdateAttendeeStatusDto } from './dto/update-attendee-status.dto';
import { EventAttendeeController } from './event-attendee.controller';
import { EventAttendeeService } from './event-attendee.service';

describe('EventAttendeeController', () => {
  let controller: EventAttendeeController;
  let service: jest.Mocked<
    Pick<
      EventAttendeeService,
      | 'getAttendees'
      | 'getAttendee'
      | 'addAttendee'
      | 'removeAttendee'
      | 'updateStatus'
      | 'getGameList'
      | 'addGameToList'
      | 'removeGameFromList'
    >
  >;
  beforeEach(async () => {
    service = {
      getAttendees: jest.fn(),
      getAttendee: jest.fn(),
      addAttendee: jest.fn(),
      removeAttendee: jest.fn(),
      updateStatus: jest.fn(),
      getGameList: jest.fn(),
      addGameToList: jest.fn(),
      removeGameFromList: jest.fn(),
    } satisfies Partial<jest.Mocked<EventAttendeeService>> as typeof service;

    const { module } = await createTestingModuleWithDb({
      controllers: [EventAttendeeController],
      providers: [
        { provide: EventAttendeeService, useValue: service },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(EventAttendeeController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getAttendees', () => {
    it('delegates with the paging and wraps the rows in the envelope', async () => {
      const attendees = [stubAttendee(), stubAttendee()];
      service.getAttendees.mockResolvedValue({ rows: attendees, total: 2 });

      const pagination = paginationQuery({ limit: 10 });
      const result = await firstValueFrom(controller.getAttendees('event-1', pagination));

      expect(service.getAttendees).toHaveBeenCalledWith('event-1', pagination);
      expect(result).toEqual({
        attendees,
        pagination: { page: 1, limit: 10, total: 2, totalPages: 1, hasMore: false },
      });
    });

    // #373: `total` is what tells a client the event has more attendees than
    // the page it received.
    it('reports more pages when the event has more attendees than one page', async () => {
      service.getAttendees.mockResolvedValue({ rows: [stubAttendee()], total: 12 });

      const result = await firstValueFrom(controller.getAttendees('event-1', paginationQuery({ limit: 5 })));

      expect(result).toEqual(
        expect.objectContaining({
          pagination: { page: 1, limit: 5, total: 12, totalPages: 3, hasMore: true },
        }),
      );
    });

    // The service composes the `EventAttendee` scope; the envelope is where the
    // guard checks for it, under the resource type the handler passes. Built
    // inside a request with nothing composed, it must fail, and the failure
    // has to name `EventAttendee` itself: a handler passing a sibling list's
    // type fails here too, and in a real request answers 500.
    it('builds its envelope under the EventAttendee scope guard', async () => {
      service.getAttendees.mockResolvedValue({ rows: [], total: 0 });

      const envelope = ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.getAttendees('event-1', paginationQuery({ limit: 10 }))),
      );

      await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
      await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.EventAttendee}'`);
    });
  });

  describe('getAttendee', () => {
    it('delegates to service with abilities and wraps in { attendee }', async () => {
      const attendee = stubAttendee({ id: 'att-42' });
      service.getAttendee.mockResolvedValue(attendee);

      const result = await firstValueFrom(controller.getAttendee('event-1', 'att-42'));

      expect(service.getAttendee).toHaveBeenCalledWith('event-1', 'att-42');
      expect(result).toEqual({ attendee });
    });
  });

  describe('addAttendee', () => {
    it('delegates to service.addAttendee', async () => {
      const created = stubAttendee({ id: 'att-new' });
      service.addAttendee.mockResolvedValue(created);

      const dto: AddAttendeeDto = { userId: 'user-2' };
      const result = await firstValueFrom(controller.addAttendee('event-1', dto));

      expect(service.addAttendee).toHaveBeenCalledWith('event-1', dto);
      expect(result).toEqual({
        message: t('success.attendee.added'),
        attendee: created,
      });
    });
  });

  describe('removeAttendee', () => {
    it('delegates to service.removeAttendee', async () => {
      const removed = stubAttendee({ id: 'att-del' });
      service.removeAttendee.mockResolvedValue(removed);

      const result = await firstValueFrom(controller.removeAttendee('event-1', 'att-del'));

      expect(service.removeAttendee).toHaveBeenCalledWith('event-1', 'att-del');
      expect(result).toEqual({
        message: t('success.attendee.removed'),
        attendee: removed,
      });
    });
  });

  describe('updateStatus', () => {
    it('delegates with abilities and returns updated attendee', async () => {
      const updated = stubAttendee({
        status: EventParticipationStatus.Attending,
      });
      service.updateStatus.mockResolvedValue(updated);

      const dto: UpdateAttendeeStatusDto = {
        status: EventParticipationStatus.Attending,
      };
      const result = await firstValueFrom(controller.updateStatus('event-1', 'att-1', dto));

      expect(service.updateStatus).toHaveBeenCalledWith('event-1', 'att-1', dto);
      expect(result).toEqual({
        message: t('success.attendee.status_updated'),
        attendee: updated,
      });
    });
  });

  describe('getGameList', () => {
    it('delegates with abilities and returns { games }', async () => {
      const games = [{ id: 'gl-1' }] as EventAttendeeGameList[];
      service.getGameList.mockResolvedValue(games);

      const result = await firstValueFrom(controller.getGameList('event-1', 'att-1'));

      expect(service.getGameList).toHaveBeenCalledWith('event-1', 'att-1');
      expect(result).toEqual({ games });
    });
  });

  describe('addGameToList', () => {
    it('delegates and returns { entry }', async () => {
      const entry = { id: 'gl-new' } as EventAttendeeGameList;
      service.addGameToList.mockResolvedValue(entry);

      const result = await firstValueFrom(controller.addGameToList('event-1', 'att-1', { collectionId: 'gc-1' }));

      expect(service.addGameToList).toHaveBeenCalledWith('event-1', 'att-1', {
        collectionId: 'gc-1',
      });
      expect(result).toEqual({ message: t('success.attendee.game_added'), entry });
    });
  });

  describe('removeGameFromList', () => {
    it('delegates to service.removeGameFromList and returns { entry }', async () => {
      const entry = { id: 'gl-del' } as EventAttendeeGameList;
      service.removeGameFromList.mockResolvedValue(entry);

      const result = await firstValueFrom(controller.removeGameFromList('event-1', 'att-1', 'gl-del'));

      expect(service.removeGameFromList).toHaveBeenCalledWith('event-1', 'att-1', 'gl-del');
      expect(result).toEqual({ message: t('success.attendee.game_removed'), entry });
    });
  });
});

function stubAttendee(overrides: Partial<EventAttendee> = {}): EventAttendee {
  return makeEventAttendee({
    eventId: 'event-1',
    userId: 'user-1',
    ...overrides,
  });
}
