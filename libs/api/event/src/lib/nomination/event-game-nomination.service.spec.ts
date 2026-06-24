import type { EventAttendee, EventAttendeeGameList, EventGame, EventGameNomination, EventPolicy } from '@bge/database';
import { Action, NominationStatus, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NominateGameDto } from './dto/nominate-game.dto';
import { EventGameNominationService } from './event-game-nomination.service';

const COND = { id: 'sentinel-condition' };

describe('EventGameNominationService', () => {
  let service: EventGameNominationService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    abilityService.getActingUserId.mockReturnValue('user-1');

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventGameNominationService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventGameNominationService);
    db.eventAttendee.findUnique.mockResolvedValue({ id: 'att-1' } as EventAttendee);
  });

  afterEach(() => jest.clearAllMocks());

  it('getNominations → read', async () => {
    db.event.count.mockResolvedValue(1);
    db.eventGameNomination.findMany.mockResolvedValue([]);

    await service.getNominations('event-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.EventGameNomination,
      Action.read,
    );
    expect(db.eventGameNomination.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ eventId: 'event-1', AND: [COND] }) }),
    );
  });

  it('getNomination → read', async () => {
    db.event.count.mockResolvedValue(1);
    db.eventGameNomination.findUnique.mockResolvedValue({ id: 'nom-1' } as EventGameNomination);

    await service.getNomination('event-1', 'nom-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.EventGameNomination,
      Action.read,
    );
  });

  it('withdraw → update', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      nominatedById: 'att-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.eventGameNomination.update.mockResolvedValue({ id: 'nom-1' } as EventGameNomination);

    await service.withdraw('event-1', 'nom-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.EventGameNomination,
      Action.update,
    );
    expect(db.eventGameNomination.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'nom-1', AND: [COND] }) }),
    );
  });

  it('withdraw forbids a non-nominator', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      nominatedById: 'someone-else',
      status: NominationStatus.Open,
    } as EventGameNomination);

    await expect(service.withdraw('event-1', 'nom-1')).rejects.toThrow(ForbiddenException);
  });

  it('hostApprove → update', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.AwaitingApproval,
      platformGameId: 'pg-1',
      occurrenceId: null,
    } as EventGameNomination);
    db.eventGameNomination.update.mockResolvedValue({ id: 'nom-1' } as EventGameNomination);
    db.eventGameNomination.findUniqueOrThrow.mockResolvedValue({
      platformGameId: 'pg-1',
      suppliedFromId: 'gl-1',
      nominatedById: 'att-1',
    } as EventGameNomination);
    db.eventGame.create.mockResolvedValue({ id: 'eg-1' } as EventGame);

    await service.hostApprove('event-1', 'nom-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.EventGameNomination,
      Action.update,
    );
  });

  it('resolveNomination rejects a non-Open nomination', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      eventId: 'event-1',
      status: NominationStatus.Passed,
      platformGameId: 'pg-1',
      occurrenceId: null,
      releaseId: null,
      votingDeadline: null,
      nominatedById: 'att-1',
      suppliedFromId: 'gl-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as EventGameNomination);

    await expect(service.resolveNomination('event-1', 'nom-1')).rejects.toThrow(BadRequestException);
  });

  it('nominate does not filter by abilities', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: 'RequiresVote',
      votingWindowHours: null,
    } as EventPolicy);
    db.eventAttendeeGameList.findUnique.mockResolvedValue({
      id: 'gl-1',
      attendeeId: 'att-1',
      collectionId: 'col-1',
      createdAt: new Date(),
      attendee: { eventId: 'event-1' },
      collection: { platformGameId: 'pg-1' },
    } as EventAttendeeGameList);

    db.eventGameNomination.create.mockResolvedValue({ id: 'nom-1' } as EventGameNomination);

    await service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto);

    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
  });
});
