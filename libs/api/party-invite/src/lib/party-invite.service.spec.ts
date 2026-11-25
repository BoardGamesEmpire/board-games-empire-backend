import type { Actor } from '@bge/actor-context';
import { AuditContextService } from '@bge/actor-context';
import { InviteStatus, InviteType, Prisma, SystemRole } from '@bge/database';
import type { HouseholdInviteAcceptance } from '@bge/household';
import { HouseholdInviteResponder } from '@bge/household';
import type { InvitePartyView } from '@bge/invites';
import { InviteService, PARTY_INVITE_SELECT } from '@bge/invites';
import type { MockDatabaseService } from '@bge/testing';
import { batchTransactionCall, boundPageQuery, createTestingModuleWithDb, unwrapTransaction } from '@bge/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ListReceivedInvitesQueryDto, ListSentInvitesQueryDto } from './dto';
import { PartyInviteService } from './party-invite.service';

const INVITEE_ID = 'user-invitee';
const INVITER_ID = 'user-inviter';
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

/** Prisma's delegate types want full rows; the service selects narrower ones. */
const resolves = (value: unknown) => value as never;

const ACCEPTANCE = {
  invite: partyView(),
  member: { id: 'member-new', householdId: 'hh-1' },
} as unknown as HouseholdInviteAcceptance;

/** Every row a party list reads: the party shape, plus the context it is into. */
const LISTED_SELECT = { ...PARTY_INVITE_SELECT, household: { select: { id: true, name: true } } };

const receivedQuery = (init: Partial<ListReceivedInvitesQueryDto> = {}) =>
  boundPageQuery(ListReceivedInvitesQueryDto, init);

const sentQuery = (init: Partial<ListSentInvitesQueryDto> = {}) => boundPageQuery(ListSentInvitesQueryDto, init);

const withFakeNow = async (work: () => Promise<void>) => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });

  try {
    await work();
  } finally {
    jest.useRealTimers();
  }
};

describe('PartyInviteService', () => {
  let service: PartyInviteService;
  let db: MockDatabaseService;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;
  let invites: jest.Mocked<Pick<InviteService, 'findPartyTypeWithin'>>;
  let households: jest.Mocked<Pick<HouseholdInviteResponder, 'accept' | 'decline' | 'withdraw'>> & {
    readonly type: typeof InviteType.Household;
  };

  beforeEach(async () => {
    auditContext = { getActor: jest.fn().mockReturnValue(SESSION_USER) };
    invites = { findPartyTypeWithin: jest.fn().mockResolvedValue(InviteType.Household) };
    households = {
      type: InviteType.Household,
      accept: jest.fn().mockResolvedValue(ACCEPTANCE),
      decline: jest.fn().mockResolvedValue(partyView({ status: InviteStatus.Declined })),
      withdraw: jest.fn().mockResolvedValue(partyView({ status: InviteStatus.Withdrawn })),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        PartyInviteService,
        { provide: AuditContextService, useValue: auditContext },
        { provide: InviteService, useValue: invites },
        { provide: HouseholdInviteResponder, useValue: households },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(PartyInviteService);

    unwrapTransaction(db);
    db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: true }));
    db.invite.findMany.mockResolvedValue([]);
    db.invite.count.mockResolvedValue(0);
  });

  describe.each([
    ['an API key', { kind: 'apiKey', apiKeyId: 'key-1', userId: INVITEE_ID }],
    ['an anonymous user', { kind: 'anonymous', userId: INVITEE_ID }],
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
      expect(households.accept).not.toHaveBeenCalled();
    });

    it('refuses the inbox with 403 before reading anything', async () => {
      await expect(service.listReceived(receivedQuery())).rejects.toThrow(ForbiddenException);

      expect(db.invite.findMany).not.toHaveBeenCalled();
    });

    it('refuses the sent list with 403 before reading anything', async () => {
      await expect(service.listSent(sentQuery())).rejects.toThrow(ForbiddenException);

      expect(db.invite.findMany).not.toHaveBeenCalled();
    });

    it('refuses a decline with 403 before reading anything', async () => {
      await expect(service.decline({ inviteId: 'invite-1' })).rejects.toThrow(ForbiddenException);

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(households.decline).not.toHaveBeenCalled();
    });

    it('refuses a withdraw with 403 before reading anything', async () => {
      await expect(service.withdraw('invite-1')).rejects.toThrow(ForbiddenException);

      expect(db.$transaction).not.toHaveBeenCalled();
      expect(households.withdraw).not.toHaveBeenCalled();
    });
  });

  describe('listReceived', () => {
    /** The household arm of the inbox, for the invitee with a verified address, read at NOW. */
    const householdReceivedWhere = {
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

    it("lists the user's open invites of every kind, newest first in one snapshot (#742)", () =>
      withFakeNow(async () => {
        db.invite.findMany.mockResolvedValue(resolves([{ id: 'invite-1' }]));
        db.invite.count.mockResolvedValue(1);

        const page = await service.listReceived(receivedQuery({ page: 2, limit: 10 }));

        // One arm per kind of invite; households are the only kind with one until event invites land.
        const where = { OR: [householdReceivedWhere] };
        expect(db.invite.findMany).toHaveBeenCalledWith({
          where,
          select: LISTED_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 10,
          take: 10,
        });
        expect(db.invite.count).toHaveBeenCalledWith({ where });
        expect(batchTransactionCall(db).options).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        });
        expect(page).toEqual({ rows: [{ id: 'invite-1' }], total: 1 });
      }));

    it('matches by id alone while the address is unverified', async () => {
      db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: false }));

      await service.listReceived(receivedQuery());

      const [{ where }] = db.invite.findMany.mock.calls[0] as [{ where: Prisma.InviteWhereInput }];
      const [household] = where.OR as Prisma.InviteWhereInput[];
      expect((household.AND as Prisma.InviteWhereInput[])[0]).toEqual({
        inviterId: { not: INVITEE_ID },
        OR: [{ inviteeId: INVITEE_ID }],
      });
    });

    it('filters the inbox to one type with ?type= (#742)', () =>
      withFakeNow(async () => {
        await service.listReceived(receivedQuery({ type: InviteType.Household }));

        expect(db.invite.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { OR: [householdReceivedWhere] } }),
        );
        expect(db.invite.count).toHaveBeenCalledWith({ where: { OR: [householdReceivedWhere] } });
      }));

    it('answers an empty page for a kind with no arm yet, without querying (#742)', async () => {
      // Prisma reads `OR: []` as match-nothing, but an empty page needs no round-trip to say so.
      const page = await service.listReceived(receivedQuery({ type: InviteType.Event }));

      expect(page).toEqual({ rows: [], total: 0 });
      expect(db.invite.findMany).not.toHaveBeenCalled();
      expect(db.invite.count).not.toHaveBeenCalled();
    });
  });

  describe('listSent (#751)', () => {
    beforeEach(() => auditContext.getActor.mockReturnValue(INVITER_SESSION));

    /**
     * Where the inviter is not a household member, only what they can still
     * withdraw: a server owner's invites, since leaving revoked a former
     * household member's (#747).
     */
    const withdrawableOrStillMember = {
      OR: [
        { household: { is: { members: { some: { userId: INVITER_ID } } } } },
        { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] }, expiresAt: { gt: NOW } },
      ],
    };

    const householdSentWhere = {
      type: InviteType.Household,
      inviterId: INVITER_ID,
      // An invite into a deleted household is not listed; the delete revoked it.
      household: { is: { deletedAt: null } },
      AND: [
        // Expired whether or not the sweep has stamped it, so the inviter
        // sees it lapse and can send another.
        { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending, InviteStatus.Expired] } },
        withdrawableOrStillMember,
      ],
    };

    it("lists the user's outstanding and expired invites of every kind, newest first in one snapshot", () =>
      withFakeNow(async () => {
        db.invite.findMany.mockResolvedValue(
          resolves([{ id: 'invite-1', status: InviteStatus.Pending, expiresAt: LATER }]),
        );
        db.invite.count.mockResolvedValue(1);

        const page = await service.listSent(sentQuery({ page: 2, limit: 10 }));

        const where = { OR: [householdSentWhere] };
        expect(db.invite.findMany).toHaveBeenCalledWith({
          where,
          select: LISTED_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: 10,
          take: 10,
        });
        expect(db.invite.count).toHaveBeenCalledWith({ where });
        expect(batchTransactionCall(db).options).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        });
        expect(page).toEqual({ rows: [{ id: 'invite-1', status: InviteStatus.Pending, expiresAt: LATER }], total: 1 });
      }));

    it('filters to any one status as it stands now, still only withdrawable rows where they left', () =>
      withFakeNow(async () => {
        await service.listSent(sentQuery({ status: InviteStatus.Accepted }));
        await service.listSent(sentQuery({ status: InviteStatus.Expired }));

        const householdArmOf = (call: number) => {
          const [{ where }] = db.invite.findMany.mock.calls[call] as [{ where: Prisma.InviteWhereInput }];

          return (where.OR as Prisma.InviteWhereInput[])[0];
        };

        expect(householdArmOf(0).AND).toEqual([{ status: InviteStatus.Accepted }, withdrawableOrStillMember]);
        expect(householdArmOf(1).AND).toEqual([
          {
            OR: [
              { status: InviteStatus.Expired },
              { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] }, expiresAt: { lte: NOW } },
            ],
          },
          withdrawableOrStillMember,
        ]);
      }));

    it('reports an outstanding row past its expiry as Expired', () =>
      withFakeNow(async () => {
        const lapsed = { id: 'invite-1', status: InviteStatus.AwaitingApproval, expiresAt: new Date('2026-10-01') };
        db.invite.findMany.mockResolvedValue(resolves([lapsed]));
        db.invite.count.mockResolvedValue(1);

        const page = await service.listSent(sentQuery());

        expect(page.rows).toEqual([{ ...lapsed, status: InviteStatus.Expired }]);
      }));

    it('filters the sent list to one type with ?type= (#742)', () =>
      withFakeNow(async () => {
        await service.listSent(sentQuery({ type: InviteType.Household }));

        expect(db.invite.count).toHaveBeenCalledWith({ where: { OR: [householdSentWhere] } });

        const page = await service.listSent(sentQuery({ type: InviteType.Event }));

        expect(page).toEqual({ rows: [], total: 0 });
        expect(db.invite.count).toHaveBeenCalledTimes(1);
      }));
  });

  describe('hands accept, decline and withdraw to the responder for the invite’s type (#742)', () => {
    it('reads the type bound to the invitee, with their vouched address, then accepts through the responder', async () => {
      const result = await service.accept({ inviteId: 'invite-1' });

      expect(invites.findPartyTypeWithin).toHaveBeenCalledWith(db, {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITEE_ID,
        vouchedEmail: ADDRESS,
      });
      expect(households.accept).toHaveBeenCalledWith({ inviteId: 'invite-1' }, INVITEE_ID);
      expect(result).toEqual({ type: InviteType.Household, ...ACCEPTANCE });
    });

    it('reads the type in a transaction of its own, closed before the responder opens its own', async () => {
      const order: string[] = [];
      db.$transaction.mockImplementation(((work: (tx: MockDatabaseService) => Promise<unknown>) => {
        order.push('type read opened');

        return work(db).finally(() => order.push('type read closed'));
      }) as never);
      households.accept.mockImplementation(async () => {
        order.push('responder');

        return ACCEPTANCE;
      });

      await service.accept({ inviteId: 'invite-1' });

      expect(order).toEqual(['type read opened', 'type read closed', 'responder']);
    });

    it('vouches for no address that is unverified', async () => {
      db.user.findUnique.mockResolvedValue(resolves({ email: ADDRESS, emailVerified: false }));

      await service.decline({ inviteId: 'invite-1' });

      expect(invites.findPartyTypeWithin).toHaveBeenCalledWith(db, expect.objectContaining({ vouchedEmail: null }));
    });

    it('passes a token through as the target', async () => {
      await service.accept({ token: 'live-accept-credential' });
      await service.decline({ token: 'live-accept-credential' });

      expect(invites.findPartyTypeWithin).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ target: { token: 'live-accept-credential' } }),
      );
      expect(households.accept).toHaveBeenCalledWith({ token: 'live-accept-credential' }, INVITEE_ID);
      expect(households.decline).toHaveBeenCalledWith({ token: 'live-accept-credential' }, INVITEE_ID);
    });

    it('declines through the responder, answering the invite it returns', async () => {
      const invite = await service.decline({ inviteId: 'invite-1' });

      expect(households.decline).toHaveBeenCalledWith({ inviteId: 'invite-1' }, INVITEE_ID);
      expect(invite).toEqual(partyView({ status: InviteStatus.Declined }));
    });

    it('withdraws through the responder, reading the type bound to the inviter and asking nothing of their address', async () => {
      auditContext.getActor.mockReturnValue(INVITER_SESSION);

      const invite = await service.withdraw('invite-1');

      expect(invites.findPartyTypeWithin).toHaveBeenCalledWith(db, {
        target: { inviteId: 'invite-1' },
        actingUserId: INVITER_ID,
      });
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(households.withdraw).toHaveBeenCalledWith('invite-1', INVITER_ID);
      expect(invite).toEqual(partyView({ status: InviteStatus.Withdrawn }));
    });

    it("hands nothing on when the type read refuses, as it refuses a stranger's invite", async () => {
      invites.findPartyTypeWithin.mockRejectedValue(new NotFoundException('not yours'));

      await expect(service.accept({ inviteId: 'invite-1' })).rejects.toThrow(NotFoundException);
      await expect(service.decline({ inviteId: 'invite-1' })).rejects.toThrow(NotFoundException);
      await expect(service.withdraw('invite-1')).rejects.toThrow(NotFoundException);

      expect(households.accept).not.toHaveBeenCalled();
      expect(households.decline).not.toHaveBeenCalled();
      expect(households.withdraw).not.toHaveBeenCalled();
    });
  });

  describe('answers 404 for an invite whose type has no responder (#742)', () => {
    beforeEach(() => invites.findPartyTypeWithin.mockResolvedValue(InviteType.Event));

    it('by id, as a stranger is answered, handing nothing on', async () => {
      const notFound = { status: 404, response: expect.objectContaining({ key: 'errors.invite.not_found' }) };

      await expect(service.accept({ inviteId: 'invite-1' })).rejects.toMatchObject(notFound);
      await expect(service.decline({ inviteId: 'invite-1' })).rejects.toMatchObject(notFound);
      await expect(service.withdraw('invite-1')).rejects.toMatchObject(notFound);

      expect(households.accept).not.toHaveBeenCalled();
      expect(households.decline).not.toHaveBeenCalled();
      expect(households.withdraw).not.toHaveBeenCalled();
    });

    it('by token, never echoing the token', async () => {
      const notFound = { status: 404, response: expect.objectContaining({ key: 'errors.invite.link_not_found' }) };

      await expect(service.accept({ token: 'live-accept-credential' })).rejects.toMatchObject(notFound);
      await expect(service.decline({ token: 'live-accept-credential' })).rejects.toMatchObject(notFound);
    });
  });
});
