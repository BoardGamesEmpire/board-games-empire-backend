import { AuditContextService, type Actor } from '@bge/actor-context';
import { InviteStatus, InviteType, Prisma } from '@bge/database';
import { PARTY_INVITE_SELECT } from '@bge/invites';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import { PartyInviteService } from './party-invite.service';

const INVITEE_ID = 'user-invitee';
const ADDRESS = 'sam@example.test';
const NOW = new Date('2026-10-15T12:00:00Z');

const SESSION_USER: Actor = { kind: 'user', userId: INVITEE_ID } as Actor;

/** Prisma's delegate types want full rows; the service selects narrower ones. */
const resolves = (value: unknown) => value as never;

describe('PartyInviteService', () => {
  let service: PartyInviteService;
  let db: MockDatabaseService;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;

  beforeEach(async () => {
    auditContext = { getActor: jest.fn().mockReturnValue(SESSION_USER) };

    const ctx = await createTestingModuleWithDb({
      providers: [PartyInviteService, { provide: AuditContextService, useValue: auditContext }],
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

    it('refuses the inbox with 403 before reading anything', async () => {
      await expect(service.listReceived(paginationQuery())).rejects.toThrow(ForbiddenException);

      expect(db.invite.findMany).not.toHaveBeenCalled();
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
            { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] } },
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
});
