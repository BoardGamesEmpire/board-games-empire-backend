import type { EventAttendee } from '@bge/database';
import {
  Action,
  EventParticipationStatus,
  InviteStatus,
  InviteType,
  NominationStatus,
  Prisma,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { CodedHttpException } from '@bge/i18n';
import type {
  InviteAcceptance,
  InviteDeclination,
  InviteOffer,
  InvitePartyView,
  InviteRevocation,
  InviteWithdrawal,
} from '@bge/invites';
import { InviteService } from '@bge/invites';
import type { UserAbilityCheck } from '@bge/permissions';
import { AbilityService, PermissionsService } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, makeEventAttendee, rawQueryText, unwrapTransaction } from '@bge/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AttendeeAddedEvent } from '../attendee/events/attendee.events';
import { NominationResumedEvent } from '../nomination/events/nomination.events';
import { OfferedGameService } from '../offered-game/offered-game.service';
import type { OfferedGame } from '../offered-game/offered-game.types';
import type { EventRosterRow } from './event-invite-authority';
import { EventInviteResponder } from './event-invite-responder';

const INVITEE_ID = 'user-invitee';
const INVITER_ID = 'user-inviter';
const EVENT_ID = 'event-1';
const LATER = new Date('2099-01-01T00:00:00Z');
const NOW = new Date('2026-11-25T12:00:00Z');

const partyView = (overrides: Partial<InvitePartyView> = {}): InvitePartyView => ({
  id: 'invite-1',
  status: InviteStatus.Accepted,
  type: InviteType.Event,
  inviteeName: 'Sam',
  expiresAt: LATER,
  createdAt: NOW,
  role: { id: 'role-cohost', name: SystemRole.EventCoHost },
  inviter: { id: INVITER_ID, username: 'inviter', profile: null },
  inviteeEmail: null,
  message: null,
  ...overrides,
});

const rosterRow = (userId: string, name: SystemRole): EventRosterRow => ({ userId, role: { role: { name } } });

const INVITER_SEAT = rosterRow(INVITER_ID, SystemRole.EventHost);

/** The event as the sender check reads it under the lock: its household, its policy's switch, its live roster. */
const eventRow = (attendees: EventRosterRow[] = [INVITER_SEAT]) => ({
  householdId: 'hh-1',
  policy: { allowMemberInvites: true },
  attendees,
});

/** The invitee's row as the seat writes it, attending. */
const seatedRow = (overrides: Partial<EventAttendee> = {}) =>
  makeEventAttendee({
    id: 'att-new',
    eventId: EVENT_ID,
    userId: INVITEE_ID,
    status: EventParticipationStatus.Attending,
    rsvpDate: NOW,
    invitedById: 'att-inviter',
    ...overrides,
  });

/** Prisma's delegate types want full rows; the responder selects narrower ones. */
const resolves = (value: unknown) => value as never;

describe('EventInviteResponder', () => {
  let responder: EventInviteResponder;
  let db: MockDatabaseService;
  let invites: jest.Mocked<
    Pick<
      InviteService,
      | 'findPartyScopeWithin'
      | 'findAcceptableWithin'
      | 'acceptWithin'
      | 'revokeWithin'
      | 'declineWithin'
      | 'withdrawWithin'
      | 'emit'
    >
  >;
  let abilities: jest.Mocked<Pick<AbilityService, 'userAbilityWithin'>>;
  let senderCan: jest.Mock<boolean, Parameters<UserAbilityCheck>>;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser'>>;
  let emitter: { emit: jest.Mock };
  let offeredGames: jest.Mocked<Pick<OfferedGameService, 'forAttendees'>>;
  let offer: InviteOffer;
  let acceptance: InviteAcceptance;
  let revocation: InviteRevocation;
  let declination: InviteDeclination;
  let withdrawal: InviteWithdrawal;

  /** How the invitee names the invite to the lib: by its id, bound to them and to event invites. */
  const lookup = {
    target: { inviteId: 'invite-1' },
    actingUserId: INVITEE_ID,
    type: InviteType.Event,
  };

  /** Records when the responder's transaction commits, so a post-commit duty can be checked against it. */
  const trackCommit = () => {
    const state = { committed: false };
    db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
      const result = await work(db);
      state.committed = true;

      return result;
    }) as never);

    return state;
  };

  const emittedNamed = (name: string) => emitter.emit.mock.calls.filter(([emitted]) => emitted === name);

  beforeEach(async () => {
    offer = {
      id: 'invite-1',
      inviterId: INVITER_ID,
      role: { id: 'role-cohost', name: SystemRole.EventCoHost },
      needsApproval: false,
    };
    acceptance = { invite: partyView(), event: { eventName: 'invite.accepted' } as never };
    revocation = {
      invite: partyView({ status: InviteStatus.Revoked }),
      event: { eventName: 'invite.revoked', subjectId: 'invite-1' } as never,
    };
    declination = {
      invite: partyView({ status: InviteStatus.Declined }),
      event: { eventName: 'invite.declined' } as never,
    };
    withdrawal = {
      invite: partyView({ status: InviteStatus.Withdrawn }),
      event: { eventName: 'invite.withdrawn' } as never,
    };

    invites = {
      findPartyScopeWithin: jest.fn().mockResolvedValue({ eventId: EVENT_ID }),
      findAcceptableWithin: jest.fn().mockImplementation(() => Promise.resolve(offer)),
      acceptWithin: jest.fn().mockImplementation(() => Promise.resolve(acceptance)),
      revokeWithin: jest.fn().mockImplementation(() => Promise.resolve(revocation)),
      declineWithin: jest.fn().mockImplementation(() => Promise.resolve(declination)),
      withdrawWithin: jest.fn().mockImplementation(() => Promise.resolve(withdrawal)),
      emit: jest.fn(),
    };
    senderCan = jest.fn().mockReturnValue(true);
    abilities = { userAbilityWithin: jest.fn().mockResolvedValue(senderCan) };
    permissions = { invalidateUser: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };
    offeredGames = {
      forAttendees: jest
        .fn()
        .mockImplementation(
          async (ids: readonly string[]) => new Map(ids.map((id): [string, OfferedGame[]] => [id, []])),
        ),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventInviteResponder,
        { provide: InviteService, useValue: invites },
        { provide: AbilityService, useValue: abilities },
        { provide: PermissionsService, useValue: permissions },
        { provide: EventEmitter2, useValue: emitter },
        { provide: OfferedGameService, useValue: offeredGames },
      ],
    });

    db = ctx.db;
    responder = ctx.module.get(EventInviteResponder);

    unwrapTransaction(db);
    // The event is live under its lock (#1065).
    db.event.count.mockResolvedValue(1);
    db.event.findUnique.mockResolvedValue(resolves(eventRow()));
    // The inviter's own attendee row, which the seat names as who invited them.
    db.eventAttendee.findUnique.mockResolvedValue(resolves({ id: 'att-inviter' }));
    // No row of the invitee's on the event, removed or not, unless a test says so.
    db.eventAttendee.findFirst.mockResolvedValue(null);
    db.eventAttendee.create.mockResolvedValue(seatedRow());
    db.eventGameNomination.updateManyAndReturn.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  it('answers for event invites, the type the party routes pick it by (#742)', () => {
    expect(responder.type).toBe(InviteType.Event);
  });

  describe('accept', () => {
    it('locks the event before reading the offer, and asks about the sender under the lock (#742)', async () => {
      // The participant role, so the sender is asked one question: a co-host
      // offer asks a second, about the role.
      offer = { ...offer, role: null };
      // Recorded by hand: the mocked client and these mocks keep separate call
      // counters, so `invocationCallOrder` cannot compare them.
      const order: string[] = [];
      invites.findPartyScopeWithin.mockImplementation(async () => (order.push('read'), { eventId: EVENT_ID }));
      db.$queryRaw.mockImplementation(
        (async (query: unknown) => (
          order.push(/FROM events/.test(rawQueryText(query)) ? 'lock' : 'other'),
          []
        )) as never,
      );
      invites.findAcceptableWithin.mockImplementation(async () => (order.push('offer'), offer));
      senderCan.mockImplementation(() => (order.push('sender'), true));
      invites.acceptWithin.mockImplementation(async () => (order.push('accept'), acceptance));
      db.eventAttendee.create.mockImplementation((async () => (order.push('seat'), seatedRow())) as never);

      await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(invites.findPartyScopeWithin).toHaveBeenCalledWith(db, lookup, InviteType.Event);
      expect(invites.findAcceptableWithin).toHaveBeenCalledWith(db, lookup);
      expect(invites.acceptWithin).toHaveBeenCalledWith(db, lookup);
      expect(rawQueryText(db.$queryRaw.mock.calls[0][0])).toBe('SELECT id FROM events WHERE id = ? FOR SHARE');

      // The event row, then the invite, then the roster: the order the
      // event's delete takes the first two in, so the two can't deadlock.
      // The sender is asked about under the lock, and only once the lib would
      // let the accept through.
      expect(order).toEqual(['read', 'lock', 'offer', 'sender', 'accept', 'seat']);
    });

    it('passes a token through as the target, vouching no address: an event invite names its invitee by id (#742)', async () => {
      await responder.accept({ token: 'live-accept-credential' }, INVITEE_ID);

      expect(invites.findPartyScopeWithin).toHaveBeenCalledWith(
        db,
        { target: { token: 'live-accept-credential' }, actingUserId: INVITEE_ID, type: InviteType.Event },
        InviteType.Event,
      );
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it("seats the invitee attending, in the role the invite offers, invited by the inviter's attendee row (#742)", async () => {
      const { invite, attendee } = await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(db.eventAttendee.findUnique).toHaveBeenCalledWith({
        where: { eventId_userId: { eventId: EVENT_ID, userId: INVITER_ID }, removedAt: null },
        select: { id: true },
      });
      expect(db.eventAttendee.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: EventParticipationStatus.Attending,
            rsvpDate: expect.any(Date),
            role: { create: { role: { connect: { name: SystemRole.EventCoHost } } } },
            event: { connect: { id: EVENT_ID } },
            user: { connect: { id: INVITEE_ID } },
            invitedBy: { connect: { id: 'att-inviter' } },
          }),
        }),
      );
      expect(invite).toBe(acceptance.invite);
      expect(attendee).toMatchObject({ id: 'att-new', userId: INVITEE_ID, availableGames: [] });
    });

    it('seats the invitee as a participant when the invite offers no role (#742)', async () => {
      offer = { ...offer, role: null };

      await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(db.eventAttendee.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            role: { create: { role: { connect: { name: SystemRole.EventParticipant } } } },
          }),
        }),
      );
    });

    // A household owner or admin invites through the household variant
    // without attending the event (#742).
    it('names nobody as who invited them when the inviter attends nothing (#742)', async () => {
      db.eventAttendee.findUnique.mockResolvedValue(null);

      await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(db.eventAttendee.create.mock.calls[0][0].data.invitedBy).toBeUndefined();
    });

    it('revived by an inviter who attends nothing clears who invited them (#742)', async () => {
      db.eventAttendee.findUnique.mockResolvedValue(null);
      db.eventAttendee.findFirst.mockResolvedValue(
        resolves({
          id: 'att-old',
          status: EventParticipationStatus.Attending,
          invitedById: 'att-previous',
          removedAt: new Date('2026-11-01T00:00:00Z'),
        }),
      );
      db.eventAttendee.update.mockResolvedValue(seatedRow({ id: 'att-old' }));

      await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(db.eventAttendee.update.mock.calls[0][0].data.invitedBy).toEqual({ disconnect: true });
    });

    it('revives a removed row instead of inserting, and resumes the nominations of games they offer (#742, #551)', async () => {
      const removedAt = new Date('2026-11-01T00:00:00Z');
      db.eventAttendee.findFirst.mockResolvedValue(
        resolves({ id: 'att-old', status: EventParticipationStatus.Attending, invitedById: null, removedAt }),
      );
      db.eventAttendee.update.mockResolvedValue(seatedRow({ id: 'att-old' }));
      db.eventGameNomination.updateManyAndReturn.mockImplementation((async (args: {
        where: { pausedFrom?: NominationStatus };
      }) => (args.where.pausedFrom === NominationStatus.Open ? [{ id: 'nom-1' }] : [])) as never);

      const { attendee } = await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(db.eventAttendee.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: EVENT_ID, userId: INVITEE_ID } }),
      );
      expect(db.eventAttendee.update).toHaveBeenCalledWith(
        expect.objectContaining({
          // Matches nothing once a concurrent write has revived it.
          where: { id: 'att-old', removedAt: { not: null } },
          data: expect.objectContaining({
            removedAt: null,
            status: EventParticipationStatus.Attending,
            rsvpDate: expect.any(Date),
            invitedBy: { connect: { id: 'att-inviter' } },
            role: { create: { role: { connect: { name: SystemRole.EventCoHost } } } },
          }),
        }),
      );
      expect(db.eventAttendee.create).not.toHaveBeenCalled();
      expect(attendee.id).toBe('att-old');

      const [, added] = emittedNamed(AttendeeAddedEvent.eventName)[0];
      expect(added.action).toBe('update');
      expect(added.before).toEqual(expect.objectContaining({ id: 'att-old', removedAt }));
      expect(emitter.emit).toHaveBeenCalledWith(NominationResumedEvent.eventName, expect.any(NominationResumedEvent));
    });

    it("evicts the invitee's graph after commit, then announces the accept and the new attendee (#742)", async () => {
      const commit = trackCommit();
      const order: string[] = [];
      permissions.invalidateUser.mockImplementation(async () => {
        expect(commit.committed).toBe(true);
        order.push('evict');
      });
      invites.emit.mockImplementation(() => {
        order.push('invite');
      });
      emitter.emit.mockImplementation((name: string) => {
        order.push(name);
      });

      await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(permissions.invalidateUser).toHaveBeenCalledWith(INVITEE_ID);
      expect(invites.emit).toHaveBeenCalledWith([acceptance.event]);
      expect(order).toEqual(['evict', 'invite', AttendeeAddedEvent.eventName]);

      const [, added] = emittedNamed(AttendeeAddedEvent.eventName)[0];
      expect(added).toBeInstanceOf(AttendeeAddedEvent);
      expect(added.action).toBe('create');
      expect(added.after).toEqual(
        expect.objectContaining({ id: 'att-new', eventId: EVENT_ID, userId: INVITEE_ID, invitedById: 'att-inviter' }),
      );
    });

    it('answers the new attendee with the games they offer, read after commit (#742)', async () => {
      const commit = trackCommit();
      const game = { id: 'gl-1', attendeeId: 'att-new' } as OfferedGame;
      offeredGames.forAttendees.mockImplementation(async (ids) => {
        expect(commit.committed).toBe(true);

        return new Map(ids.map((id): [string, OfferedGame[]] => [id, [game]]));
      });

      const { attendee } = await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(offeredGames.forAttendees).toHaveBeenCalledWith(['att-new'], expect.any(Date));
      expect(attendee.availableGames).toEqual([game]);
    });

    it('409 and leaves the invite open for someone already attending (#742)', async () => {
      db.event.findUnique.mockResolvedValue(
        resolves(eventRow([INVITER_SEAT, rosterRow(INVITEE_ID, SystemRole.EventParticipant)])),
      );

      await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.attendee.already_attendee' }),
      });

      // The rollback leaves it outstanding: settling it would say nothing true.
      expect(invites.acceptWithin).not.toHaveBeenCalled();
      expect(invites.revokeWithin).not.toHaveBeenCalled();
      expect(db.eventAttendee.create).not.toHaveBeenCalled();
      expect(invites.emit).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('409 and revokes nothing for someone already attending whose inviter could no longer send it (#742)', async () => {
      senderCan.mockReturnValue(false);
      db.event.findUnique.mockResolvedValue(resolves(eventRow([rosterRow(INVITEE_ID, SystemRole.EventParticipant)])));

      await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.attendee.already_attendee' }),
      });

      expect(invites.revokeWithin).not.toHaveBeenCalled();
      expect(invites.emit).not.toHaveBeenCalled();
    });

    // A direct add of the same person that commits while this accept is under
    // way: its row takes the (event, user) key first.
    it.each([
      [
        'inserted',
        () =>
          db.eventAttendee.create.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            }),
          ),
      ],
      [
        'revived',
        () => {
          db.eventAttendee.findFirst.mockResolvedValue(
            resolves({ id: 'att-old', status: EventParticipationStatus.Attending, invitedById: null, removedAt: NOW }),
          );
          db.eventAttendee.update.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('No record was found', { code: 'P2025', clientVersion: 'test' }),
          );
        },
      ],
    ])('409 when a concurrent write %s their row first, announcing nothing (#742)', async (_label, arrange) => {
      arrange();

      await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.attendee.already_attendee' }),
      });

      expect(invites.emit).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('admits nobody when the event lock finds it gone: 404, as the household accept answers (#742)', async () => {
      db.event.count.mockResolvedValue(0);

      await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toThrow(NotFoundException);

      expect(invites.findAcceptableWithin).not.toHaveBeenCalled();
      expect(invites.acceptWithin).not.toHaveBeenCalled();
      expect(db.eventAttendee.create).not.toHaveBeenCalled();
    });

    it('asks nothing of the sender when the lib refuses the accept first (#742)', async () => {
      invites.findAcceptableWithin.mockRejectedValue(new ConflictException('settled'));

      await expect(responder.accept({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toThrow(ConflictException);

      expect(abilities.userAbilityWithin).not.toHaveBeenCalled();
      expect(invites.revokeWithin).not.toHaveBeenCalled();
    });

    it.each([SystemRole.EventHost, SystemRole.Owner])(
      'answers an invite offering %s as a server error, not the invitee’s (#742)',
      async (name) => {
        offer = { ...offer, role: { id: 'role-x', name } };

        const refusal = responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

        await expect(refusal).rejects.toThrow(`Invite invite-1 offers the role '${name}'`);
        await expect(refusal).rejects.not.toBeInstanceOf(ConflictException);
        expect(db.eventAttendee.create).not.toHaveBeenCalled();
      },
    );

    describe('whether the sender could still send it (#742)', () => {
      it("asks the sender's own ability, about the roster under the event policy and the role offered", async () => {
        await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

        expect(abilities.userAbilityWithin).toHaveBeenCalledWith(db, INVITER_ID);
        expect(senderCan).toHaveBeenCalledWith(Action.create, ResourceType.Invite, {
          eventId: EVENT_ID,
          event: { householdId: 'hh-1', attendees: [INVITER_SEAT] },
        });
        expect(senderCan).toHaveBeenCalledWith(Action.create, ResourceType.EventAttendee, {
          eventId: EVENT_ID,
          event: { householdId: 'hh-1' },
          role: { role: { name: SystemRole.EventCoHost } },
        });
      });

      // A participant's invite dies at accept once the policy is off.
      it('leaves the participants out of the roster it asks about while allowMemberInvites is off', async () => {
        const participantInviter = rosterRow(INVITER_ID, SystemRole.EventParticipant);
        db.event.findUnique.mockResolvedValue(
          resolves({ householdId: 'hh-1', policy: { allowMemberInvites: false }, attendees: [participantInviter] }),
        );
        offer = { ...offer, role: null };

        await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID);

        expect(senderCan).toHaveBeenCalledWith(Action.create, ResourceType.Invite, {
          eventId: EVENT_ID,
          event: { householdId: 'hh-1', attendees: [] },
        });
      });

      it('revokes and answers 409 when the inviter has left the event, committing and announcing the revoke', async () => {
        senderCan.mockReturnValue(false);
        db.event.findUnique.mockResolvedValue(resolves(eventRow([])));
        const commit = trackCommit();
        invites.emit.mockImplementation(() => expect(commit.committed).toBe(true));

        const refusal = await responder.accept({ inviteId: 'invite-1' }, INVITEE_ID).catch((error: unknown) => error);

        // The answer a revoked invite gets: nothing beyond the envelope and
        // the `state`, so the invitee learns nothing of why (#1114).
        expect(refusal).toBeInstanceOf(CodedHttpException);
        expect((refusal as CodedHttpException).getStatus()).toBe(409);
        expect((refusal as CodedHttpException).getResponse()).toMatchObject({
          code: 'INVITE_NOT_OUTSTANDING',
          state: InviteStatus.Revoked,
        });

        // By the id the read found, bound to the event, with the invitee as
        // the one revoking: the lib refuses only the inviter.
        expect(invites.revokeWithin).toHaveBeenCalledWith(db, {
          inviteId: 'invite-1',
          revokerId: INVITEE_ID,
          scope: { eventId: EVENT_ID },
        });
        expect(invites.emit).toHaveBeenCalledWith([revocation.event]);
        expect(invites.acceptWithin).not.toHaveBeenCalled();
        expect(db.eventAttendee.create).not.toHaveBeenCalled();
        expect(db.eventAttendee.update).not.toHaveBeenCalled();
        expect(permissions.invalidateUser).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      });
    });
  });

  describe('decline', () => {
    it('declines an event invite of theirs, the lib binding the type in its own read, taking no lock (#742)', async () => {
      await expect(responder.decline({ inviteId: 'invite-1' }, INVITEE_ID)).resolves.toBe(declination.invite);

      expect(invites.declineWithin).toHaveBeenCalledWith(db, lookup);
      expect(invites.findPartyScopeWithin).not.toHaveBeenCalled();
      // Only the invite row moves, so there is no event row to order it after.
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('passes a token through as the target (#742)', async () => {
      await responder.decline({ token: 'live-accept-credential' }, INVITEE_ID);

      expect(invites.declineWithin).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ target: { token: 'live-accept-credential' } }),
      );
    });

    it('announces the decline after commit (#742)', async () => {
      const commit = trackCommit();
      invites.emit.mockImplementation(() => expect(commit.committed).toBe(true));

      await responder.decline({ inviteId: 'invite-1' }, INVITEE_ID);

      expect(invites.emit).toHaveBeenCalledWith([declination.event]);
    });

    it('announces nothing when the lib refuses, as it refuses an invite of another type (#742)', async () => {
      invites.declineWithin.mockRejectedValue(new NotFoundException());

      await expect(responder.decline({ inviteId: 'invite-1' }, INVITEE_ID)).rejects.toThrow(NotFoundException);

      expect(invites.emit).not.toHaveBeenCalled();
    });
  });

  describe('withdraw', () => {
    it('withdraws an event invite of theirs, whatever their standing on the event now, taking no lock (#742)', async () => {
      await expect(responder.withdraw('invite-1', INVITER_ID)).resolves.toBe(withdrawal.invite);

      expect(invites.withdrawWithin).toHaveBeenCalledWith(db, {
        inviteId: 'invite-1',
        actingUserId: INVITER_ID,
        type: InviteType.Event,
      });
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.eventAttendee.findUnique).not.toHaveBeenCalled();
    });

    it('announces the withdrawal after commit (#742)', async () => {
      const commit = trackCommit();
      invites.emit.mockImplementation(() => expect(commit.committed).toBe(true));

      await responder.withdraw('invite-1', INVITER_ID);

      expect(invites.emit).toHaveBeenCalledWith([withdrawal.event]);
    });

    it('announces nothing when the lib refuses (#742)', async () => {
      invites.withdrawWithin.mockRejectedValue(new NotFoundException());

      await expect(responder.withdraw('invite-1', INVITER_ID)).rejects.toThrow(NotFoundException);

      expect(invites.emit).not.toHaveBeenCalled();
    });
  });
});
