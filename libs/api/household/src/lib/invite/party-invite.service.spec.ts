import { AuditContextService, type Actor } from '@bge/actor-context';
import { HouseholdMembershipOrigin, InviteStatus, InviteType, Prisma, QuotaScope, SystemRole } from '@bge/database';
import {
  InviteService,
  PARTY_INVITE_SELECT,
  type InviteAcceptance,
  type InviteDeclination,
  type InvitePartyView,
  type InviteWithdrawal,
} from '@bge/invites';
import { PermissionsService } from '@bge/permissions';
import { QuotaService, type QuotaSoftOverageEvent } from '@bge/quota';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HouseholdMemberService, type AddMemberResult } from '../member/household-member.service';
import { PartyInviteService } from './party-invite.service';

const INVITEE_ID = 'user-invitee';
const INVITER_ID = 'user-inviter';
const HOUSEHOLD_ID = 'hh-1';
const ADDRESS = 'sam@example.test';
const LATER = new Date('2099-01-01T00:00:00Z');
const NOW = new Date('2026-10-15T12:00:00Z');

const SESSION_USER: Actor = { kind: 'user', userId: INVITEE_ID } as Actor;
const INVITER_SESSION: Actor = { kind: 'user', userId: INVITER_ID } as Actor;

const partyView = (overrides: Partial<InvitePartyView> = {}): InvitePartyView => ({
  id: 'invite-1',
  status: InviteStatus.Accepted,
  type: InviteType.Household,
  inviteeName: 'Sam',
  expiresAt: LATER,
  createdAt: NOW,
  role: { id: 'role-admin', name: SystemRole.HouseholdAdmin },
  inviter: { id: INVITER_ID, username: 'inviter', profile: null },
  inviteeEmail: ADDRESS,
  message: null,
  ...overrides,
});

const OVERAGE: QuotaSoftOverageEvent = {
  scope: QuotaScope.Household,
  scopeId: HOUSEHOLD_ID,
  resource: 'household_member_count',
  currentUsage: '8',
  attemptedAmount: '1',
  limit: '8',
};

/** Prisma's delegate types want full rows; the service selects narrower ones. */
const resolves = (value: unknown) => value as never;

describe('PartyInviteService', () => {
  let service: PartyInviteService;
  let db: MockDatabaseService;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;
  let invites: jest.Mocked<
    Pick<InviteService, 'findPartyScopeWithin' | 'acceptWithin' | 'declineWithin' | 'withdrawWithin' | 'emit'>
  >;
  let members: jest.Mocked<Pick<HouseholdMemberService, 'addMemberWithin'>>;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser'>>;
  let quotas: jest.Mocked<Pick<QuotaService, 'emitSoftOverages'>>;
  let acceptance: InviteAcceptance;
  let declination: InviteDeclination;
  let withdrawal: InviteWithdrawal;
  let admission: AddMemberResult;

  beforeEach(async () => {
    acceptance = { invite: partyView(), event: { eventName: 'invite.accepted' } as never };
    declination = {
      invite: partyView({ status: InviteStatus.Declined }),
      event: { eventName: 'invite.declined' } as never,
    };
    withdrawal = {
      invite: partyView({ status: InviteStatus.Withdrawn }),
      event: { eventName: 'invite.withdrawn' } as never,
    };
    admission = { member: { id: 'member-new' } as never, admitted: true, softOverages: [OVERAGE] };

    auditContext = { getActor: jest.fn().mockReturnValue(SESSION_USER) };
    invites = {
      findPartyScopeWithin: jest.fn().mockResolvedValue({ householdId: HOUSEHOLD_ID }),
      acceptWithin: jest.fn().mockImplementation(() => Promise.resolve(acceptance)),
      declineWithin: jest.fn().mockImplementation(() => Promise.resolve(declination)),
      withdrawWithin: jest.fn().mockImplementation(() => Promise.resolve(withdrawal)),
      emit: jest.fn(),
    };
    members = { addMemberWithin: jest.fn().mockImplementation(() => Promise.resolve(admission)) };
    permissions = { invalidateUser: jest.fn().mockResolvedValue(undefined) };
    quotas = { emitSoftOverages: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        PartyInviteService,
        { provide: AuditContextService, useValue: auditContext },
        { provide: InviteService, useValue: invites },
        { provide: HouseholdMemberService, useValue: members },
        { provide: PermissionsService, useValue: permissions },
        { provide: QuotaService, useValue: quotas },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(PartyInviteService);

    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([{ id: HOUSEHOLD_ID }] as never);
    db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: true }));
    db.invite.findMany.mockResolvedValue([]);
    db.invite.count.mockResolvedValue(0);
  });

  describe.each([
    ['an API key', { kind: 'apiKey', apiKeyId: 'key-1', userId: INVITEE_ID }],
    ['an anonymous guest', { kind: 'anonymous', userId: INVITEE_ID }],
    ['the system', { kind: 'system', reason: 'sweep' }],
    [
      'a plugin',
      {
        kind: 'plugin',
        pluginId: 'plugin-1',
        unit: { scopeType: 'User', userId: INVITEE_ID },
        trigger: { kind: 'user', userId: INVITEE_ID },
      },
    ],
    ['no actor at all', null],
  ])('for %s', (_label, actor) => {
    beforeEach(() => auditContext.getActor.mockReturnValue(actor as Actor | null));

    it('refuses an accept with 403 before reading anything', async () => {
      await expect(service.accept({ inviteId: 'invite-1' })).rejects.toThrow(ForbiddenException);

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(invites.acceptWithin).not.toHaveBeenCalled();
    });

    it('refuses the inbox with 403 before reading anything', async () => {
      await expect(service.listReceived(paginationQuery())).rejects.toThrow(ForbiddenException);

      expect(db.invite.findMany).not.toHaveBeenCalled();
    });

    it('refuses a decline with 403 before reading anything', async () => {
      await expect(service.decline({ inviteId: 'invite-1' })).rejects.toThrow(ForbiddenException);

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(invites.declineWithin).not.toHaveBeenCalled();
    });

    it('refuses a withdraw with 403 before reading anything', async () => {
      await expect(service.withdraw('invite-1')).rejects.toThrow(ForbiddenException);

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(invites.withdrawWithin).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    it('locks the household between the party-bound read of it and the accept, then admits as the inviter invited', async () => {
      // Recorded by hand: the mocked client and these mocks keep separate call
      // counters, so `invocationCallOrder` cannot compare them.
      const order: string[] = [];
      invites.findPartyScopeWithin.mockImplementation(async () => (order.push('read'), { householdId: HOUSEHOLD_ID }));
      db.$queryRaw.mockImplementation((async () => (order.push('lock'), [{ id: HOUSEHOLD_ID }])) as never);
      invites.acceptWithin.mockImplementation(async () => (order.push('accept'), acceptance));
      members.addMemberWithin.mockImplementation(async () => (order.push('admit'), admission));

      const { invite, member } = await service.accept({ inviteId: 'invite-1' });

      const lookup = {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: ADDRESS,
        type: InviteType.Household,
      };
      expect(invites.findPartyScopeWithin).toHaveBeenCalledWith(db, lookup, InviteType.Household);
      expect(invites.acceptWithin).toHaveBeenCalledWith(db, lookup);
      expect(members.addMemberWithin).toHaveBeenCalledWith(db, {
        householdId: HOUSEHOLD_ID,
        userId: INVITEE_ID,
        role: SystemRole.HouseholdAdmin,
        origin: HouseholdMembershipOrigin.InviteAccepted,
        addedById: INVITER_ID,
      });

      // The household row, then the invite, then the roster: the order a soft
      // delete takes the first two in.
      expect(order).toEqual(['read', 'lock', 'accept', 'admit']);

      expect(invite).toBe(acceptance.invite);
      expect(member).toBe(admission.member);
    });

    it('vouches for no address that is unverified', async () => {
      db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: false }));

      await service.accept({ inviteId: 'invite-1' });

      expect(invites.acceptWithin).toHaveBeenCalledWith(db, {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: null,
        type: InviteType.Household,
      });
    });

    it('passes a token through as the target', async () => {
      await service.accept({ token: 'live-accept-credential' });

      expect(invites.findPartyScopeWithin).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ target: { token: 'live-accept-credential' } }),
        InviteType.Household,
      );
    });

    it('evicts the new member’s ability cache, then announces the accept and the soft caps, after commit', async () => {
      let committed = false;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        committed = true;
        return result;
      }) as never);
      permissions.invalidateUser.mockImplementation(async () => expect(committed).toBe(true));

      await service.accept({ inviteId: 'invite-1' });

      expect(permissions.invalidateUser).toHaveBeenCalledWith(INVITEE_ID);
      expect(invites.emit).toHaveBeenCalledWith([acceptance.event]);
      expect(quotas.emitSoftOverages).toHaveBeenCalledWith([OVERAGE]);
      expect(permissions.invalidateUser.mock.invocationCallOrder[0]).toBeLessThan(
        invites.emit.mock.invocationCallOrder[0],
      );
    });

    it('answers 409 for someone already a member, and does nothing after the rollback', async () => {
      admission = { ...admission, admitted: false, softOverages: [] };

      await expect(service.accept({ inviteId: 'invite-1' })).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.household.already_a_member' }),
      });

      expect(invites.emit).not.toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
      expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
    });

    it('admits with the seam’s default when the invite offers no role', async () => {
      acceptance = { ...acceptance, invite: partyView({ role: null }) };

      await service.accept({ inviteId: 'invite-1' });

      expect(members.addMemberWithin).toHaveBeenCalledWith(db, expect.objectContaining({ role: undefined }));
    });

    it.each([SystemRole.HouseholdOwner, SystemRole.User])(
      'answers an invite offering %s as a server error, not the invitee’s',
      async (name) => {
        acceptance = { ...acceptance, invite: partyView({ role: { id: 'role-x', name } }) };

        const refusal = service.accept({ inviteId: 'invite-1' });

        await expect(refusal).rejects.toThrow(`Invite invite-1 offers the role '${name}'`);
        await expect(refusal).rejects.not.toBeInstanceOf(ConflictException);
        expect(members.addMemberWithin).not.toHaveBeenCalled();
      },
    );

    it('admits nobody when the household lock finds it gone', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.accept({ inviteId: 'invite-1' })).rejects.toThrow(NotFoundException);

      expect(invites.acceptWithin).not.toHaveBeenCalled();
      expect(members.addMemberWithin).not.toHaveBeenCalled();
    });
  });

  describe('listReceived', () => {
    it("lists the user's open household invites into live households they are not in, newest first", async () => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });

      try {
        db.invite.findMany.mockResolvedValue(resolves([{ id: 'invite-1' }]));
        db.invite.count.mockResolvedValue(1);

        const page = await service.listReceived(paginationQuery({ page: 2, limit: 10 }));

        const where = {
          type: InviteType.Household,
          AND: [
            {
              inviterId: { not: INVITEE_ID },
              OR: [{ inviteeId: INVITEE_ID }, { inviteeId: null, inviteeEmail: ADDRESS, withheld: false }],
            },
            // Pending only: one awaiting approval is not yet the household's
            // offer, and the invitee does not see it until it is (#166).
            { status: InviteStatus.Pending },
            { expiresAt: { gt: NOW } },
            { household: { is: { deletedAt: null, members: { none: { userId: INVITEE_ID } } } } },
          ],
        };
        expect(db.invite.findMany).toHaveBeenCalledWith({
          where,
          select: { ...PARTY_INVITE_SELECT, household: { select: { id: true, name: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 10,
          take: 10,
        });
        expect(db.invite.count).toHaveBeenCalledWith({ where });
        expect(batchTransactionCall(db).options).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        });
        expect(page).toEqual({ rows: [{ id: 'invite-1' }], total: 1 });
      } finally {
        jest.useRealTimers();
      }
    });

    it('matches by id alone while the address is unverified', async () => {
      db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: false }));

      await service.listReceived(paginationQuery());

      const [{ where }] = db.invite.findMany.mock.calls[0] as [{ where: Prisma.InviteWhereInput }];
      expect((where.AND as Prisma.InviteWhereInput[])[0]).toEqual({
        inviterId: { not: INVITEE_ID },
        OR: [{ inviteeId: INVITEE_ID }],
      });
    });
  });

  describe('decline', () => {
    it('declines a household invite of theirs, the lib binding the type in its own read, taking no lock', async () => {
      await expect(service.decline({ inviteId: 'invite-1' })).resolves.toBe(declination.invite);

      expect(invites.declineWithin).toHaveBeenCalledWith(db, {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: ADDRESS,
        type: InviteType.Household,
      });
      // The transition's read binds the type, so no read goes ahead of it.
      expect(invites.findPartyScopeWithin).not.toHaveBeenCalled();
      // Only the invite row moves, so there is no household row to order it after.
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('vouches for no address that is unverified', async () => {
      db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: false }));

      await service.decline({ inviteId: 'invite-1' });

      expect(invites.declineWithin).toHaveBeenCalledWith(db, {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: null,
        type: InviteType.Household,
      });
    });

    it('passes a token through as the target', async () => {
      await service.decline({ token: 'live-accept-credential' });

      expect(invites.declineWithin).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ target: { token: 'live-accept-credential' } }),
      );
    });

    it('announces the decline after commit', async () => {
      let committed = false;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        committed = true;
        return result;
      }) as never);
      invites.emit.mockImplementation(() => expect(committed).toBe(true));

      await service.decline({ inviteId: 'invite-1' });

      expect(invites.emit).toHaveBeenCalledWith([declination.event]);
    });

    it('announces nothing when the lib refuses, as it refuses an invite of another type', async () => {
      invites.declineWithin.mockRejectedValue(new NotFoundException());

      await expect(service.decline({ inviteId: 'invite-1' })).rejects.toThrow(NotFoundException);

      expect(invites.emit).not.toHaveBeenCalled();
    });
  });

  describe('withdraw', () => {
    beforeEach(() => auditContext.getActor.mockReturnValue(INVITER_SESSION));

    it('withdraws a household invite of theirs, the lib binding the type in its own read, taking no lock', async () => {
      await expect(service.withdraw('invite-1')).resolves.toBe(withdrawal.invite);

      expect(invites.withdrawWithin).toHaveBeenCalledWith(db, {
        inviteId: 'invite-1',
        actingUserId: INVITER_ID,
        type: InviteType.Household,
      });
      expect(invites.findPartyScopeWithin).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('asks nothing of the inviter’s role in the household, nor of their address', async () => {
      await service.withdraw('invite-1');

      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(db.householdMember.findUnique).not.toHaveBeenCalled();
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('announces the withdrawal after commit', async () => {
      let committed = false;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        committed = true;
        return result;
      }) as never);
      invites.emit.mockImplementation(() => expect(committed).toBe(true));

      await service.withdraw('invite-1');

      expect(invites.emit).toHaveBeenCalledWith([withdrawal.event]);
    });

    it('announces nothing when the lib refuses, as it refuses an invite of another type', async () => {
      invites.withdrawWithin.mockRejectedValue(new NotFoundException());

      await expect(service.withdraw('invite-1')).rejects.toThrow(NotFoundException);

      expect(invites.emit).not.toHaveBeenCalled();
    });
  });
});
