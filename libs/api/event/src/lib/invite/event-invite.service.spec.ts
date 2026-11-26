import { Action, InviteStatus, InviteType, Prisma, QuotaScope, ResourceType, SystemRole } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import type { InviteContextView, InviteCreation, InvitePartyView, InviteRevocation } from '@bge/invites';
import { CONTEXT_INVITE_SELECT, InviteService } from '@bge/invites';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { QuotaCheckResult, QuotaSoftOverageEvent } from '@bge/quota';
import { QuotaExceededException, QuotaService } from '@bge/quota';
import type { MockDatabaseService } from '@bge/testing';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  rawQueryText,
  unwrapTransaction,
} from '@bge/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { CreateEventInviteDto } from './dto/create-event-invite.dto';
import type { ListEventInvitesQueryDto } from './dto/list-event-invites-query.dto';
import { EventInviteService } from './event-invite.service';

const COND = { id: 'sentinel-condition' };
const NOW = new Date('2026-11-25T12:00:00Z');
const LATER = new Date('2026-12-02T12:00:00Z');

type RosterRow = { role: { role: { name: string } } | null; userId: string | null };

const rosterRow = (userId: string, name: SystemRole): RosterRow => ({ userId, role: { role: { name } } });

const HOST = rosterRow('host-1', SystemRole.EventHost);
const PARTICIPANT = rosterRow('participant-1', SystemRole.EventParticipant);
const ROSTER = [HOST, PARTICIPANT];

/** The event as the authority read selects it: its household, its policy's switch, and its live roster. */
const eventRow = (allowMemberInvites = true, attendees: RosterRow[] = ROSTER) => ({
  householdId: 'hh-1',
  policy: { allowMemberInvites },
  attendees,
});

/** What a create, list or revoke asks the invite grants about: the event, its household and a roster. */
const inviteInstance = (attendees: RosterRow[] = ROSTER) => ({
  eventId: 'ev-1',
  event: { householdId: 'hh-1', attendees },
});

const contextView = (overrides: Partial<InviteContextView> = {}): InviteContextView => ({
  id: 'invite-1',
  status: InviteStatus.Pending,
  type: InviteType.Event,
  inviteeName: 'Sam',
  expiresAt: LATER,
  createdAt: NOW,
  role: { id: 'role-EventParticipant', name: SystemRole.EventParticipant },
  inviter: { id: 'host-1', username: 'host', profile: null },
  ...overrides,
});

const partyView = (): InvitePartyView => ({ ...contextView(), inviteeEmail: null, message: null });

/** What `consume` answers when no quota row applies. */
const UNCONSTRAINED: QuotaCheckResult = {
  allowed: true,
  scope: null,
  currentUsage: null,
  limit: null,
  softOverage: false,
  constraints: [],
  softOverages: [],
};

describe('EventInviteService', () => {
  let service: EventInviteService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<
      AbilityService,
      'getActingUserId' | 'assertCurrentActorCan' | 'currentActorCan' | 'getCurrentResourceConditions'
    >
  >;
  let invites: jest.Mocked<Pick<InviteService, 'createWithin' | 'revokeWithin' | 'emit'>>;
  let quotas: jest.Mocked<Pick<QuotaService, 'consume' | 'emitSoftOverages'>>;
  let creation: InviteCreation;
  let revocation: InviteRevocation;

  /** Refuses with 403 whenever `refuses` says so, as the ability service's assert does. */
  const refusing = (refuses: (type: string, instance: unknown) => boolean) => {
    abilityService.currentActorCan.mockImplementation((_action, type, instance) => !refuses(type, instance));
    abilityService.assertCurrentActorCan.mockImplementation((_action, type, instance) => {
      if (refuses(type, instance)) {
        throw new ForbiddenException();
      }
    });
  };

  /** Whether an instance's roster leaves the participant row out, as the policy roster does when the switch is off. */
  const withoutParticipant = (instance: unknown) =>
    !(instance as { event: { attendees?: RosterRow[] } }).event.attendees?.some(
      (row) => row.role?.role.name === SystemRole.EventParticipant,
    );

  beforeEach(async () => {
    abilityService = {
      getActingUserId: jest.fn().mockReturnValue('host-1'),
      assertCurrentActorCan: jest.fn(),
      currentActorCan: jest.fn().mockReturnValue(true),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
    };
    creation = {
      invite: partyView(),
      event: { eventName: 'invite.created' } as never,
      expired: [{ eventName: 'invite.expired' } as never],
    };
    revocation = {
      invite: contextView({ status: InviteStatus.Revoked }),
      event: { eventName: 'invite.revoked' } as never,
    };
    invites = {
      createWithin: jest.fn().mockImplementation(() => Promise.resolve(creation)),
      revokeWithin: jest.fn().mockImplementation(() => Promise.resolve(revocation)),
      emit: jest.fn(),
    };
    quotas = {
      consume: jest.fn().mockResolvedValue(UNCONSTRAINED),
      emitSoftOverages: jest.fn(),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventInviteService,
        // The real composer over the mocked ability service, so the list's
        // where clause is the merge it runs.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: InviteService, useValue: invites },
        { provide: QuotaService, useValue: quotas },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventInviteService);

    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([{ id: 'ev-1' }] as never);
    db.event.count.mockResolvedValue(1);
    db.event.findUnique.mockResolvedValue(eventRow() as never);
    db.eventAttendee.findFirst.mockResolvedValue(null);
    // Every invitee is a person; the invitee gate's other reads find no row:
    // the default policy and preference, and no friendship.
    db.user.findUnique.mockImplementation(((args: { where: { id: string } }) =>
      Promise.resolve({ id: args.where.id })) as never);
    db.user.findUniqueOrThrow.mockResolvedValue({ username: 'sam', profile: { displayName: 'Sam' } } as never);
    db.role.findUnique.mockImplementation(((args: { where: { name: string } }) =>
      Promise.resolve({ id: `role-${args.where.name}` })) as never);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createInvite', () => {
    const dto = (overrides: Partial<CreateEventInviteDto> = {}): CreateEventInviteDto => ({
      userId: 'user-2',
      ...overrides,
    });

    it('locks the event, reads its roster under the lock, asks, then writes the invite (#742)', async () => {
      // Logged by hand: the database double's mocks do not share the call
      // counter the other doubles use.
      const steps: string[] = [];
      db.$queryRaw.mockImplementation((() => {
        steps.push('lock');
        return Promise.resolve([{ id: 'ev-1' }]);
      }) as never);
      db.event.findUnique.mockImplementation((() => {
        steps.push('roster');
        return Promise.resolve(eventRow());
      }) as never);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        steps.push('check');
      });
      invites.createWithin.mockImplementation(() => {
        steps.push('insert');
        return Promise.resolve(creation);
      });

      await service.createInvite('ev-1', dto());

      expect(steps).toEqual(['lock', 'roster', 'check', 'insert']);
      expect(rawQueryText(db.$queryRaw.mock.calls[0]?.[0])).toMatch(/FOR SHARE$/);
      expect(db.event.findUnique).toHaveBeenCalledWith({
        where: { id: 'ev-1' },
        select: {
          householdId: true,
          policy: { select: { allowMemberInvites: true } },
          attendees: {
            where: { removedAt: null },
            select: { userId: true, role: { select: { role: { select: { name: true } } } } },
          },
        },
      });
      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.create,
        ResourceType.Invite,
        inviteInstance(),
      );
    });

    it('writes an event invite offering the role, as the inviter, naming the invitee (#742)', async () => {
      const invite = await service.createInvite('ev-1', dto({ message: 'Come play' }));

      expect(invites.createWithin).toHaveBeenCalledWith(db, {
        type: InviteType.Event,
        eventId: 'ev-1',
        inviterId: 'host-1',
        inviteeId: 'user-2',
        inviteeName: 'Sam',
        roleId: `role-${SystemRole.EventParticipant}`,
        message: 'Come play',
      });
      expect(invite).toBe(creation.invite);
    });

    it('emits the expired rivals and the created invite after commit, then any soft quota (#742)', async () => {
      const overage = { eventName: 'quota.soft_overage' } as unknown as QuotaSoftOverageEvent;
      quotas.consume.mockResolvedValue({ ...UNCONSTRAINED, softOverages: [overage] });
      db.$transaction.mockImplementation((async (callback: (client: MockDatabaseService) => Promise<unknown>) => {
        const result = await callback(db);
        expect(invites.emit).not.toHaveBeenCalled();
        expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
        return result;
      }) as never);

      await service.createInvite('ev-1', dto());

      expect(invites.emit).toHaveBeenCalledWith([...creation.expired, creation.event]);
      expect(quotas.emitSoftOverages).toHaveBeenCalledWith([overage]);
    });

    it('refuses before writing when the instance check denies (#742)', async () => {
      refusing((type) => type === ResourceType.Invite);

      await expect(service.createInvite('ev-1', dto())).rejects.toBeInstanceOf(ForbiddenException);

      // Nothing about the invitee is read or answered for a caller with no say
      // over the event: not whether they exist, nor whether they attend.
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(db.eventAttendee.findFirst).not.toHaveBeenCalled();
      expect(quotas.consume).not.toHaveBeenCalled();
      expect(invites.createWithin).not.toHaveBeenCalled();
      expect(invites.emit).not.toHaveBeenCalled();
    });

    it('answers 404 for a missing or deleted event, and writes nothing (#742)', async () => {
      db.event.count.mockResolvedValue(0);

      await expect(service.createInvite('ev-1', dto())).rejects.toBeInstanceOf(NotFoundException);

      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      expect(invites.createWithin).not.toHaveBeenCalled();
    });

    describe('offering a role (#742)', () => {
      it('asks only the invite grants when offering participant', async () => {
        await service.createInvite('ev-1', dto());

        expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalledWith(
          Action.create,
          ResourceType.EventAttendee,
          expect.anything(),
        );
      });

      it('asks the direct add’s grant about the row an accept would write, for any other role', async () => {
        await service.createInvite('ev-1', dto({ role: SystemRole.EventCoHost }));

        expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.EventAttendee, {
          eventId: 'ev-1',
          event: { householdId: 'hh-1' },
          role: { role: { name: SystemRole.EventCoHost } },
        });
        expect(invites.createWithin).toHaveBeenCalledWith(
          db,
          expect.objectContaining({ roleId: `role-${SystemRole.EventCoHost}` }),
        );
      });

      it('a participant offering co-host is refused', async () => {
        abilityService.getActingUserId.mockReturnValue('participant-1');
        refusing((type) => type === ResourceType.EventAttendee);

        await expect(service.createInvite('ev-1', dto({ role: SystemRole.EventCoHost }))).rejects.toBeInstanceOf(
          ForbiddenException,
        );

        expect(db.user.findUnique).not.toHaveBeenCalled();
        expect(invites.createWithin).not.toHaveBeenCalled();
      });
    });

    describe('allowMemberInvites (#742)', () => {
      beforeEach(() => db.event.findUnique.mockResolvedValue(eventRow(false) as never));

      it('MEMBER_INVITES_OFF only for a participant', async () => {
        // A participant: their only inviting grant is the participant arm,
        // which the policy roster no longer matches.
        abilityService.getActingUserId.mockReturnValue('participant-1');
        refusing((type, instance) => type === ResourceType.Invite && withoutParticipant(instance));

        const refusal = await service.createInvite('ev-1', dto()).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(CodedHttpException);
        expect(refusal).toMatchObject({
          status: 403,
          response: { code: 'MEMBER_INVITES_OFF', message: t('errors.event.member_invites_off') },
        });
        expect(db.user.findUnique).not.toHaveBeenCalled();
        expect(invites.createWithin).not.toHaveBeenCalled();
      });

      it('asks the full roster first, so another denial is the usual 403', async () => {
        refusing((type) => type === ResourceType.Invite);

        const refusal = await service.createInvite('ev-1', dto()).catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(ForbiddenException);
        expect(refusal).not.toBeInstanceOf(CodedHttpException);
      });

      it('leaves the participant rows out of the roster the invite grants are asked about', async () => {
        await service.createInvite('ev-1', dto());

        expect(abilityService.currentActorCan).toHaveBeenCalledWith(
          Action.create,
          ResourceType.Invite,
          inviteInstance([HOST]),
        );
        expect(invites.createWithin).toHaveBeenCalled();
      });

      it('lets an actor whose other grants match the policy roster invite, as a household owner who participates', async () => {
        // The household variant reads no roster, so the switch leaves it be.
        abilityService.getActingUserId.mockReturnValue('participant-1');

        await service.createInvite('ev-1', dto());

        expect(invites.createWithin).toHaveBeenCalled();
      });
    });

    it('answers 404 for an id that names no person, after the authority checks (#742)', async () => {
      db.user.findUnique.mockResolvedValue(null);

      await expect(service.createInvite('ev-1', dto())).rejects.toBeInstanceOf(NotFoundException);

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalled();
      expect(invites.createWithin).not.toHaveBeenCalled();
    });

    it('409 for someone already attending (#742)', async () => {
      db.eventAttendee.findFirst.mockResolvedValue({ id: 'attendee-2' } as never);

      await expect(service.createInvite('ev-1', dto())).rejects.toThrow(
        new ConflictException(t('errors.attendee.already_attendee')),
      );

      expect(db.eventAttendee.findFirst).toHaveBeenCalledWith({
        where: { eventId: 'ev-1', userId: 'user-2', removedAt: null },
        select: { id: true },
      });
      expect(quotas.consume).not.toHaveBeenCalled();
      expect(invites.createWithin).not.toHaveBeenCalled();
    });

    it('refuses an invite to yourself with 400 before reading anything about the invitee (#742)', async () => {
      await expect(service.createInvite('ev-1', dto({ userId: 'host-1' }))).rejects.toThrow(
        new BadRequestException(t('errors.invite.self_invite')),
      );

      expect(invites.createWithin).not.toHaveBeenCalled();
    });

    describe('the daily invite quota (#742)', () => {
      it('charges the daily invite quota inside the transaction', async () => {
        await service.createInvite('ev-1', dto());

        expect(quotas.consume).toHaveBeenCalledWith('event_invite_daily_count', 1n, { userId: 'host-1' }, db);
        expect(quotas.consume.mock.invocationCallOrder[0]).toBeLessThan(
          invites.createWithin.mock.invocationCallOrder[0],
        );
      });

      it('refuses past a hard quota with 402, and writes nothing', async () => {
        quotas.consume.mockResolvedValue({
          ...UNCONSTRAINED,
          allowed: false,
          scope: QuotaScope.User,
          limit: 5n,
          currentUsage: 5n,
        });

        await expect(service.createInvite('ev-1', dto())).rejects.toBeInstanceOf(QuotaExceededException);

        expect(invites.createWithin).not.toHaveBeenCalled();
        expect(invites.emit).not.toHaveBeenCalled();
      });
    });
  });

  describe('inviteWithin', () => {
    // The event's create calls it for each invitee, under its own authority
    // and in its own transaction, where the creator's ability has no rule for
    // the event yet (#742).
    it('asks the acting user nothing (#742)', async () => {
      const result = await service.inviteWithin(db as unknown as Prisma.TransactionClient, {
        eventId: 'ev-1',
        inviterId: 'host-1',
        userId: 'user-2',
        role: SystemRole.EventParticipant,
        message: null,
      });

      expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      expect(abilityService.currentActorCan).not.toHaveBeenCalled();
      expect(result.invite).toBe(creation.invite);
      expect(result.events).toEqual([...creation.expired, creation.event]);
    });
  });

  describe('listInvites', () => {
    const query = (overrides: Partial<ListEventInvitesQueryDto> = {}) =>
      Object.assign(paginationQuery({ limit: 10 }), overrides) as ListEventInvitesQueryDto;

    beforeEach(() => {
      db.invite.findMany.mockResolvedValue([] as never);
      db.invite.count.mockResolvedValue(0);
    });

    it('asks about the event’s invites before its liveness, so a stranger learns nothing (#742)', async () => {
      refusing(() => true);

      await expect(service.listInvites('ev-1', query())).rejects.toBeInstanceOf(ForbiddenException);

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.read,
        ResourceType.Invite,
        inviteInstance(),
      );
      expect(db.event.count).not.toHaveBeenCalled();
      expect(db.invite.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 for a deleted event to a caller who may read its invites (#742)', async () => {
      db.event.count.mockResolvedValue(0);

      await expect(service.listInvites('ev-1', query())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lists the open and the expired invites by default, newest first, under the read ceiling (#742)', async () => {
      const page = query();
      await service.listInvites('ev-1', page);

      const where = {
        eventId: 'ev-1',
        AND: [{ status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending, InviteStatus.Expired] } }, COND],
      };
      expect(db.invite.findMany).toHaveBeenCalledWith({
        where,
        select: CONTEXT_INVITE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: page.skip,
        take: page.pageSize,
      });
      expect(db.invite.count).toHaveBeenCalledWith({ where });
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Invite, Action.read);
      expect(batchTransactionCall(db).options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });

    it('answers each row with the status it has now (#742)', async () => {
      const past = new Date(Date.now() - 60_000);
      db.invite.findMany.mockResolvedValue([contextView({ expiresAt: past })] as never);
      db.invite.count.mockResolvedValue(1);

      const { rows, total } = await service.listInvites('ev-1', query());

      expect(rows).toEqual([expect.objectContaining({ id: 'invite-1', status: InviteStatus.Expired })]);
      expect(total).toBe(1);
    });

    it('filters on one status as it stands now (#742)', async () => {
      await service.listInvites('ev-1', query({ status: InviteStatus.Revoked }));

      const [args] = db.invite.findMany.mock.calls[0] as [{ where: unknown }];
      expect(JSON.stringify(args.where)).toContain(InviteStatus.Revoked);
      expect(JSON.stringify(args.where)).not.toContain(InviteStatus.Pending);
    });
  });

  describe('revokeInvite', () => {
    it('locks the event, asks about this invite’s status under the lock, then revokes it bound to the event (#742)', async () => {
      const steps: string[] = [];
      db.$queryRaw.mockImplementation((() => {
        steps.push('lock');
        return Promise.resolve([{ id: 'ev-1' }]);
      }) as never);
      db.event.findUnique.mockImplementation(((args: { select: Record<string, unknown> }) => {
        // The lock's own read of the row takes no select; the roster's does.
        steps.push(args.select ? 'roster' : 'row');
        return Promise.resolve(args.select ? eventRow() : { id: 'ev-1', householdId: 'hh-1' });
      }) as never);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        steps.push('check');
      });
      invites.revokeWithin.mockImplementation(() => {
        steps.push('revoke');
        return Promise.resolve(revocation);
      });

      const invite = await service.revokeInvite('ev-1', 'invite-1');

      expect(steps).toEqual(['lock', 'row', 'roster', 'check', 'revoke']);
      expect(rawQueryText(db.$queryRaw.mock.calls[0]?.[0])).toMatch(/FOR NO KEY UPDATE$/);
      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.update,
        ResourceType.Invite,
        { id: 'invite-1', ...inviteInstance() },
        Prisma.InviteScalarFieldEnum.status,
      );
      expect(invites.revokeWithin).toHaveBeenCalledWith(db, {
        inviteId: 'invite-1',
        revokerId: 'host-1',
        scope: { eventId: 'ev-1' },
      });
      expect(invite).toBe(revocation.invite);
    });

    it('refuses before revoking when the instance check denies (#742)', async () => {
      refusing(() => true);

      await expect(service.revokeInvite('ev-1', 'invite-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(invites.revokeWithin).not.toHaveBeenCalled();
      expect(invites.emit).not.toHaveBeenCalled();
    });

    it('emits the revoked invite after commit (#742)', async () => {
      db.$transaction.mockImplementation((async (callback: (client: MockDatabaseService) => Promise<unknown>) => {
        const result = await callback(db);
        expect(invites.emit).not.toHaveBeenCalled();
        return result;
      }) as never);

      await service.revokeInvite('ev-1', 'invite-1');

      expect(invites.emit).toHaveBeenCalledWith([revocation.event]);
    });
  });
});
