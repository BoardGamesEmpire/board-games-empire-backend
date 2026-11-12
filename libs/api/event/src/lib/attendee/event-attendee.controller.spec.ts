import { EventAttendee, EventAttendeeGameList, EventParticipationStatus, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { PoliciesGuard } from '@bge/permissions';
import { ListScopeNotComposedError } from '@bge/shared';
import { createTestingModuleWithDb, makeEventAttendee, paginationQuery } from '@bge/testing';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DECORATORS } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { ClsServiceManager } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import type { OfferedGame } from '../offered-game/offered-game.types';
import { AddAttendeeDto } from './dto/add-attendee.dto';
import { UpdateAttendeeStatusDto } from './dto/update-attendee-status.dto';
import { EventAttendeeController } from './event-attendee.controller';
import { EventAttendeeService, type AttendeeWithGames } from './event-attendee.service';
import { OFFER_REFUSALS, OfferRefusal, type OfferResult } from './offer-outcome';

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
      | 'offerGames'
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
      offerGames: jest.fn(),
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
    it('wraps the per-attendee games in the paged envelope (#1001)', async () => {
      const games = [{ id: 'gl-1' }] as OfferedGame[];
      service.getGameList.mockResolvedValue({ rows: games, total: 3 });

      const pagination = paginationQuery({ limit: 1 });
      const result = await firstValueFrom(controller.getGameList('event-1', 'att-1', pagination));

      expect(service.getGameList).toHaveBeenCalledWith('event-1', 'att-1', pagination);
      expect(result).toEqual({
        games,
        pagination: { page: 1, limit: 1, total: 3, totalPages: 3, hasMore: true },
      });
    });

    // The service composes the offered-games scope; the envelope checks for it
    // under the type the handler names, as the attendee list's does.
    it('builds its envelope under the EventAttendeeGameList scope guard', async () => {
      service.getGameList.mockResolvedValue({ rows: [], total: 0 });

      const envelope = ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.getGameList('event-1', 'att-1', paginationQuery({ limit: 10 }))),
      );

      await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.EventAttendeeGameList}'`);
    });
  });

  describe('addGameToList', () => {
    it('delegates and returns { entry }', async () => {
      const entry = { id: 'gl-new' } as OfferedGame;
      service.addGameToList.mockResolvedValue(entry);

      const result = await firstValueFrom(controller.addGameToList('event-1', 'att-1', { collectionId: 'gc-1' }));

      expect(service.addGameToList).toHaveBeenCalledWith('event-1', 'att-1', {
        collectionId: 'gc-1',
      });
      expect(result).toEqual({ message: t('success.attendee.game_added'), entry });
    });
  });

  // #1188: a batch whose ids partly fail still succeeds as a request, so it
  // answers 200, not 201, and the results say what happened to each.
  describe('offerGames', () => {
    it('answers 200 with the results in request order', async () => {
      const results: OfferResult[] = [
        { collectionId: 'col-1', outcome: 'added', entry: { id: 'gl-1' } as OfferedGame },
        {
          collectionId: 'col-2',
          outcome: 'refused',
          reason: OfferRefusal.NotFound,
          message: t('errors.attendee.game_collection_entry_not_found', { collectionId: 'col-2' }),
        },
      ];
      service.offerGames.mockResolvedValue(results);

      const body = { items: [{ collectionId: 'col-1' }, { collectionId: 'col-2' }] };
      const result = await firstValueFrom(controller.offerGames('event-1', 'att-1', body));

      expect(service.offerGames).toHaveBeenCalledWith('event-1', 'att-1', body);
      expect(result).toEqual({ results });
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, EventAttendeeController.prototype.offerGames)).toBe(Http.Ok);
    });

    // A client generated from the OpenAPI document branches on `reason`, so
    // the document carries it as an enum, not only as prose. Each outcome is
    // its own variant, so what an outcome always carries is required (#1188).
    it('documents each outcome as its own variant, with its outcome and refusal reason as enums', () => {
      const responses = Reflect.getMetadata(DECORATORS.API_RESPONSE, EventAttendeeController.prototype.offerGames);
      const [offered, refused] = responses['200'].schema.properties.results.items.oneOf;

      expect(offered.required).toEqual(['collectionId', 'outcome', 'entry']);
      expect(offered.properties.outcome.enum).toEqual(['added', 'alreadyOffered']);
      expect(refused.required).toEqual(['collectionId', 'outcome', 'reason', 'message']);
      expect(refused.properties.outcome.enum).toEqual(['refused']);
      expect(refused.properties.reason.enum).toEqual(OFFER_REFUSALS);
      expect(OFFER_REFUSALS).toEqual([
        'notFound',
        'notInAttendeesCollection',
        'removedFromCollection',
        'notAnExpansionOfBase',
        'baseRefused',
      ]);
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

function stubAttendee(overrides: Partial<EventAttendee> = {}): AttendeeWithGames {
  return {
    ...makeEventAttendee({
      eventId: 'event-1',
      userId: 'user-1',
      ...overrides,
    }),
    user: null,
    role: null,
    availableGames: [],
  };
}
