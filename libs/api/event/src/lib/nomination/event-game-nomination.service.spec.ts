import type {
  EventAttendee,
  EventAttendeeGameList,
  EventGame,
  EventGameNomination,
  EventGameVote,
  EventPolicy,
} from '@bge/database';
import { Action, GameAdditionMode, NominationStatus, ResourceType, ScheduledGameRole, VoteType } from '@bge/database';
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
import {
  GameAddedToEventEvent,
  NominationCreatedEvent,
  NominationResolvedEvent,
  NominationWithdrawnEvent,
  VoteCastEvent,
} from './events/nomination.events';

const COND = { id: 'sentinel-condition' };

describe('EventGameNominationService', () => {
  let service: EventGameNominationService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    abilityService.getActingUserId.mockReturnValue('user-1');
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventGameNominationService,
        { provide: EventEmitter2, useValue: emitter },
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

  it('withdraw emits a NominationWithdrawnEvent carrying the status transition', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      nominatedById: 'att-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.eventGameNomination.update.mockResolvedValue({
      id: 'nom-1',
      eventId: 'event-1',
      status: NominationStatus.Withdrawn,
    } as EventGameNomination);

    await service.withdraw('event-1', 'nom-1');

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(NominationWithdrawnEvent.eventName);
    expect(emitted).toBeInstanceOf(NominationWithdrawnEvent);
    expect(emitted.action).toBe('update');
    expect(emitted.subjectId).toBe('nom-1');
    expect(emitted.before).toEqual({ id: 'nom-1', eventId: 'event-1', status: NominationStatus.Open });
    expect(emitted.after).toEqual({ id: 'nom-1', eventId: 'event-1', status: NominationStatus.Withdrawn });
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

  it('hostApprove emits GameAddedToEvent (create) then NominationResolved (update)', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.AwaitingApproval,
      platformGameId: 'pg-1',
      occurrenceId: null,
    } as EventGameNomination);
    db.eventGameNomination.update.mockResolvedValue({
      id: 'nom-1',
      eventId: 'event-1',
      platformGameId: 'pg-1',
      status: NominationStatus.Approved,
    } as EventGameNomination);
    db.eventGameNomination.findUniqueOrThrow.mockResolvedValue({
      platformGameId: 'pg-1',
      suppliedFromId: 'gl-1',
      nominatedById: 'att-nominator',
    } as EventGameNomination);
    db.eventGame.create.mockResolvedValue({
      id: 'eg-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      suppliedById: 'gl-1',
      nominationId: 'nom-1',
      addedById: null,
      role: ScheduledGameRole.Primary,
    } as EventGame);

    await service.hostApprove('event-1', 'nom-1');

    const [gameName, gameEvent] = emitter.emit.mock.calls[0];
    expect(gameName).toBe(GameAddedToEventEvent.eventName);
    expect(gameEvent).toBeInstanceOf(GameAddedToEventEvent);
    expect(gameEvent.action).toBe('create');
    expect(gameEvent.subjectId).toBe('eg-1');
    expect(gameEvent.eventId).toBe('event-1');
    // Row addedById is null for elevated games — the nominator arrives as context.
    expect(gameEvent.addedByAttendeeId).toBe('att-nominator');
    expect(gameEvent.after).toEqual(
      expect.objectContaining({ id: 'eg-1', platformGameId: 'pg-1', nominationId: 'nom-1', addedById: null }),
    );

    const [resolvedName, resolvedEvent] = emitter.emit.mock.calls[1];
    expect(resolvedName).toBe(NominationResolvedEvent.eventName);
    expect(resolvedEvent).toBeInstanceOf(NominationResolvedEvent);
    expect(resolvedEvent.action).toBe('update');
    expect(resolvedEvent.subjectId).toBe('nom-1');
    expect(resolvedEvent.elevatedToEventGameId).toBe('eg-1');
    expect(resolvedEvent.before).toEqual(
      expect.objectContaining({ id: 'nom-1', status: NominationStatus.AwaitingApproval }),
    );
    expect(resolvedEvent.after).toEqual(expect.objectContaining({ id: 'nom-1', status: NominationStatus.Approved }));
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

  it('castVote emits a create-shaped VoteCastEvent on the first vote', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.eventGameVote.findUnique.mockResolvedValue(null);
    db.eventGameVote.upsert.mockResolvedValue({
      id: 'vote-1',
      eventGameNominationId: 'nom-1',
      attendeeId: 'att-1',
      voteType: VoteType.For,
      priority: null,
      comment: null,
    } as EventGameVote);

    await service.castVote('event-1', 'nom-1', { voteType: VoteType.For });

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(VoteCastEvent.eventName);
    expect(emitted).toBeInstanceOf(VoteCastEvent);
    expect(emitted.action).toBe('create');
    expect(emitted.subjectId).toBe('vote-1');
    expect(emitted.before).toBeNull();
    expect(emitted.after).toEqual({
      id: 'vote-1',
      eventGameNominationId: 'nom-1',
      attendeeId: 'att-1',
      voteType: VoteType.For,
      priority: null,
      comment: null,
    });
  });

  it('castVote emits an update-shaped VoteCastEvent on a changed vote', async () => {
    db.eventGameNomination.findUnique.mockResolvedValue({
      id: 'nom-1',
      status: NominationStatus.Open,
    } as EventGameNomination);
    db.eventGameVote.findUnique.mockResolvedValue({
      id: 'vote-1',
      voteType: VoteType.Against,
      priority: null,
      comment: null,
    } as EventGameVote);
    db.eventGameVote.upsert.mockResolvedValue({
      id: 'vote-1',
      eventGameNominationId: 'nom-1',
      attendeeId: 'att-1',
      voteType: VoteType.For,
      priority: null,
      comment: null,
    } as EventGameVote);

    await service.castVote('event-1', 'nom-1', { voteType: VoteType.For });

    const [, emitted] = emitter.emit.mock.calls[0];
    expect(emitted).toBeInstanceOf(VoteCastEvent);
    expect(emitted.action).toBe('update');
    expect(emitted.before).toEqual({ id: 'vote-1', voteType: VoteType.Against, priority: null, comment: null });
    expect(emitted.after).toEqual({ id: 'vote-1', voteType: VoteType.For, priority: null, comment: null });
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

  it('nominate emits a NominationCreatedEvent with the created row snapshot', async () => {
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
    db.eventGameNomination.create.mockResolvedValue({
      id: 'nom-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      nominatedById: 'att-1',
      suppliedFromId: 'gl-1',
      status: NominationStatus.Open,
      votingDeadline: null,
    } as EventGameNomination);

    await service.nominate('event-1', { platformGameId: 'pg-1', suppliedFromId: 'gl-1' } as NominateGameDto);

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(NominationCreatedEvent.eventName);
    expect(emitted).toBeInstanceOf(NominationCreatedEvent);
    expect(emitted.action).toBe('create');
    expect(emitted.subjectId).toBe('nom-1');
    expect(emitted.before).toBeNull();
    expect(emitted.after).toEqual({
      id: 'nom-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      nominatedById: 'att-1',
      suppliedFromId: 'gl-1',
      status: NominationStatus.Open,
      votingDeadline: null,
    });
  });

  it('directAddGame emits a GameAddedToEventEvent with the acting attendee as context', async () => {
    db.eventPolicy.findUnique.mockResolvedValue({
      gameAdditionMode: GameAdditionMode.Direct,
      votingWindowHours: null,
    } as EventPolicy);
    db.eventGame.create.mockResolvedValue({
      id: 'eg-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      suppliedById: 'gl-1',
      nominationId: null,
      addedById: 'att-1',
      role: ScheduledGameRole.Primary,
    } as EventGame);

    await service.directAddGame('event-1', { platformGameId: 'pg-1', suppliedById: 'gl-1' } as never);

    const [name, emitted] = emitter.emit.mock.calls[0];
    expect(name).toBe(GameAddedToEventEvent.eventName);
    expect(emitted).toBeInstanceOf(GameAddedToEventEvent);
    expect(emitted.action).toBe('create');
    expect(emitted.subjectId).toBe('eg-1');
    expect(emitted.eventId).toBe('event-1');
    expect(emitted.addedByAttendeeId).toBe('att-1');
    expect(emitted.before).toBeNull();
    expect(emitted.after).toEqual({
      id: 'eg-1',
      eventId: 'event-1',
      occurrenceId: null,
      platformGameId: 'pg-1',
      suppliedById: 'gl-1',
      nominationId: null,
      addedById: 'att-1',
      role: ScheduledGameRole.Primary,
    });
  });
});
