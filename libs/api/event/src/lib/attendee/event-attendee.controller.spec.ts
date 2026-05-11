import { EventAttendee, EventAttendeeGameList, EventParticipationStatus } from '@bge/database';
import { AppAbility, PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb, makeEventAttendee } from '@bge/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthGuard, UserSession } from '@thallesp/nestjs-better-auth';
import type { ClsService } from 'nestjs-cls';
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
  let cls: jest.Mocked<ClsService>;

  const mockUserAbility = { rules: [] } as unknown as AppAbility;
  const mockApiKeyAbility = { rules: [] } as unknown as AppAbility;
  const expectedAbilities = [mockUserAbility, mockApiKeyAbility];

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

    const { module, cls: mockCls } = await createTestingModuleWithDb({
      controllers: [EventAttendeeController],
      providers: [
        { provide: EventAttendeeService, useValue: service },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(EventAttendeeController);
    cls = mockCls;

    cls.get.mockImplementation((key: unknown) => {
      if (key === 'userAbility') return mockUserAbility;
      if (key === 'apiKeyAbility') return mockApiKeyAbility;
      return undefined;
    });
  });

  afterEach(() => jest.clearAllMocks());

  describe('getAttendees', () => {
    it('delegates to service with abilities and wraps in { attendees }', async () => {
      const attendees = [stubAttendee(), stubAttendee()];
      service.getAttendees.mockResolvedValue(attendees);

      const result = await firstValueFrom(controller.getAttendees('event-1'));

      expect(service.getAttendees).toHaveBeenCalledWith('event-1', expectedAbilities);
      expect(result).toEqual({ attendees });
    });
  });

  describe('getAttendee', () => {
    it('delegates to service with abilities and wraps in { attendee }', async () => {
      const attendee = stubAttendee({ id: 'att-42' });
      service.getAttendee.mockResolvedValue(attendee);

      const result = await firstValueFrom(controller.getAttendee('event-1', 'att-42'));

      expect(service.getAttendee).toHaveBeenCalledWith('event-1', 'att-42', expectedAbilities);
      expect(result).toEqual({ attendee });
    });
  });

  describe('addAttendee', () => {
    it('delegates with session userId as invitedBy', async () => {
      const created = stubAttendee({ id: 'att-new' });
      service.addAttendee.mockResolvedValue(created);

      const dto: AddAttendeeDto = { userId: 'user-2' };
      const result = await firstValueFrom(controller.addAttendee('event-1', makeSession('user-host'), dto));

      expect(service.addAttendee).toHaveBeenCalledWith('event-1', dto, 'user-host');
      expect(result).toEqual({
        message: 'Attendee added successfully',
        attendee: created,
      });
    });
  });

  describe('removeAttendee', () => {
    it('delegates with session userId as removedBy and abilities', async () => {
      const removed = stubAttendee({ id: 'att-del' });
      service.removeAttendee.mockResolvedValue(removed);

      const result = await firstValueFrom(controller.removeAttendee('event-1', 'att-del', makeSession('user-host')));

      expect(service.removeAttendee).toHaveBeenCalledWith('event-1', 'att-del', 'user-host', expectedAbilities);
      expect(result).toEqual({
        message: 'Attendee removed successfully',
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

      expect(service.updateStatus).toHaveBeenCalledWith('event-1', 'att-1', dto, expectedAbilities);
      expect(result).toEqual({
        message: 'Attendee status updated',
        attendee: updated,
      });
    });
  });

  describe('getGameList', () => {
    it('delegates with abilities and returns { games }', async () => {
      const games = [{ id: 'gl-1' }] as EventAttendeeGameList[];
      service.getGameList.mockResolvedValue(games);

      const result = await firstValueFrom(controller.getGameList('event-1', 'att-1'));

      expect(service.getGameList).toHaveBeenCalledWith('event-1', 'att-1', expectedAbilities);
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
      expect(result).toEqual({ message: 'Game added to list', entry });
    });
  });

  describe('removeGameFromList', () => {
    it('delegates with abilities and returns { entry }', async () => {
      const entry = { id: 'gl-del' } as EventAttendeeGameList;
      service.removeGameFromList.mockResolvedValue(entry);

      const result = await firstValueFrom(controller.removeGameFromList('event-1', 'att-1', 'gl-del'));

      expect(service.removeGameFromList).toHaveBeenCalledWith('event-1', 'att-1', 'gl-del', expectedAbilities);
      expect(result).toEqual({ message: 'Game removed from list', entry });
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

function makeSession(userId = 'user-1') {
  return { user: { id: userId } } as UserSession;
}
