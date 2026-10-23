import { InviteStatus, InviteType, Prisma } from '@bge/database';
import { uniqueViolation } from '@bge/database/testing';
import { createMockDatabaseService, createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InviteEvents } from './constants/invite-events.constant';
import { DEFAULT_INVITE_TTL_MS, INVITE_TOKEN_MINT_ATTEMPTS } from './constants/invite.constants';
import {
  InviteAcceptedEvent,
  InviteApprovedEvent,
  InviteCreatedEvent,
  InviteDeclinedEvent,
  InviteExpiredEvent,
  InviteRevokedEvent,
  InviteWithdrawnEvent,
  type InviteDomainEvent,
} from './events/invite.events';
import { InviteService, receivedInviteWhere } from './invite.service';
import {
  CONTEXT_INVITE_SELECT,
  INVITE_SNAPSHOT_SELECT,
  PARTY_INVITE_SELECT,
  TRANSITION_SELECT,
  type InviteTransitionRow,
} from './read-shapes';

const PAST = new Date('2026-10-01T00:00:00Z');
const FUTURE = new Date('2099-01-01T00:00:00Z');
const INVITER_ID = 'user-inviter';
const INVITEE_ID = 'user-invitee';
const STRANGER_ID = 'user-stranger';
const ADDRESS_HOLDER_ID = 'user-address-holder';
const TOKEN = 'live-accept-credential';
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

const TERMINAL = [
  InviteStatus.Accepted,
  InviteStatus.Declined,
  InviteStatus.Expired,
  InviteStatus.Revoked,
  InviteStatus.Withdrawn,
] as const;

const INVITER = { id: INVITER_ID, username: 'inviter', profile: { avatarUrl: null, displayName: 'The Inviter' } };

/** The row a transition reads, as `TRANSITION_SELECT` shapes it. */
function transitionRow(overrides: Partial<InviteTransitionRow> = {}): InviteTransitionRow {
  return {
    id: 'inv-1',
    status: InviteStatus.Pending,
    type: InviteType.Household,
    inviteeName: 'Sam',
    expiresAt: FUTURE,
    createdAt: PAST,
    role: { id: 'role-member', name: 'HouseholdMember' },
    inviter: INVITER,
    inviteeEmail: 'sam@example.test',
    message: null,
    inviterId: INVITER_ID,
    inviteeId: INVITEE_ID,
    householdId: 'hh-1',
    eventId: null,
    roleId: 'role-member',
    respondedAt: null,
    ...overrides,
  };
}

/**
 * What the database would hand back for a row, INCLUDING the token. The real
 * selects never ask for it; the mock returns it so a projection that stopped
 * dropping it would fail here rather than in production.
 */
function rowWithToken(overrides: Partial<InviteTransitionRow> = {}) {
  return { ...transitionRow(overrides), token: TOKEN };
}

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

const scalarKeysOf = (select: Record<string, unknown>) => Object.keys(select).sort();

/** The `where` a party's read binds to the acting user. */
const partyWhereById = (id: string, actor: string) => ({ id, OR: [{ inviterId: actor }, { inviteeId: actor }] });
const partyWhereByToken = (token: string, actor: string) => ({
  token,
  OR: [{ inviterId: actor }, { inviteeId: actor }, { inviteeId: null, withheld: false }],
});
/** By id, with an address the caller vouches is the actor's. */
const partyWhereByAddress = (id: string, actor: string, address: string) => ({
  id,
  OR: [{ inviterId: actor }, { inviteeId: actor }, { inviteeId: null, inviteeEmail: address, withheld: false }],
});

function expectNoToken(event: InviteDomainEvent): void {
  expect(JSON.stringify(event)).not.toContain(TOKEN);
  expect(event.after).not.toHaveProperty('token');
  expect(event.before ?? {}).not.toHaveProperty('token');
}

/**
 * Lets the expiry stamp a refusal leaves behind run to completion. The
 * refusal never waits on it (that is the point), so a test that asserts on
 * the stamp has to.
 */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A statement that never comes back: a pool with no free connection. */
const never = () => new Promise<never>(() => undefined);

describe('InviteService', () => {
  let service: InviteService;
  let db: MockDatabaseService;
  let tx: MockDatabaseService;
  let emitter: { emit: jest.Mock };
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(async () => {
    emitter = { emit: jest.fn() };
    tx = createMockDatabaseService();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const ctx = await createTestingModuleWithDb({
      providers: [InviteService, { provide: EventEmitter2, useValue: emitter }],
    });

    db = ctx.db;
    service = ctx.module.get(InviteService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('findForParty', () => {
    it('reads on the lib connection, bound to the acting user, and returns the party view', async () => {
      db.invite.findFirst.mockResolvedValue(rowWithToken() as never);

      const invite = await service.findForParty({ target: { inviteId: 'inv-1' }, actingUserId: INVITEE_ID });

      expect(db.invite.findFirst).toHaveBeenCalledWith({
        where: partyWhereById('inv-1', INVITEE_ID),
        select: TRANSITION_SELECT,
      });
      expect(scalarKeysOf(invite)).toEqual(scalarKeysOf(PARTY_INVITE_SELECT));
      expect(invite).not.toHaveProperty('token');
      expect(invite.status).toBe(InviteStatus.Pending);
    });

    it('computes an expired status for an outstanding row past its date, without writing', async () => {
      db.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);

      const invite = await service.findForParty({ target: { inviteId: 'inv-1' }, actingUserId: INVITER_ID });

      expect(invite.status).toBe(InviteStatus.Expired);
      expect(db.invite.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('reaches an email-only invite by its link', async () => {
      db.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);

      await service.findForParty({ target: { token: TOKEN }, actingUserId: STRANGER_ID });

      expect(db.invite.findFirst).toHaveBeenCalledWith({
        where: partyWhereByToken(TOKEN, STRANGER_ID),
        select: TRANSITION_SELECT,
      });
    });

    it('reaches no withheld invite by its link, which nobody was sent (#278)', async () => {
      db.invite.findFirst.mockResolvedValue(null);

      await expect(service.findForParty({ target: { token: TOKEN }, actingUserId: STRANGER_ID })).rejects.toThrow(
        NotFoundException,
      );

      const { where } = db.invite.findFirst.mock.calls[0]?.[0] as { where: Prisma.InviteWhereInput };
      expect(where.OR).toContainEqual({ inviteeId: null, withheld: false });
      expect(where.OR).not.toContainEqual({ inviteeId: null });
    });

    it('lets the inviter reach a withheld invite by its link as by id, so no read tells them it was withheld (#278)', async () => {
      db.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);

      await service.findForParty({ target: { token: TOKEN }, actingUserId: INVITER_ID });

      const { where } = db.invite.findFirst.mock.calls[0]?.[0] as { where: Prisma.InviteWhereInput };
      // Unfiltered. A 404 here, where every other invite of theirs answers,
      // would be the tell the mark exists to hide.
      expect(where.OR).toContainEqual({ inviterId: INVITER_ID });
      expect(where).not.toHaveProperty('withheld');
    });

    it('404s a stranger rather than confirming the invite exists', async () => {
      db.invite.findFirst.mockResolvedValue(null);

      await expect(service.findForParty({ target: { inviteId: 'inv-1' }, actingUserId: STRANGER_ID })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('reaches an invite by address by its id through an address the caller vouches for, never a withheld one', async () => {
      db.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);

      await service.findForParty({
        target: { inviteId: 'inv-1' },
        actingUserId: ADDRESS_HOLDER_ID,
        vouchedEmail: 'SAM@example.test',
      });

      expect(db.invite.findFirst).toHaveBeenCalledWith({
        where: partyWhereByAddress('inv-1', ADDRESS_HOLDER_ID, 'sam@example.test'),
        select: TRANSITION_SELECT,
      });
    });
  });

  describe('findPartyScopeWithin', () => {
    it("reads the household on the caller's transaction, bound to the party and the type", async () => {
      tx.invite.findFirst.mockResolvedValue({ id: 'inv-1', householdId: 'hh-1', eventId: null } as never);

      const scope = await service.findPartyScopeWithin(
        asTx(tx),
        { target: { inviteId: 'inv-1' }, actingUserId: ADDRESS_HOLDER_ID, vouchedEmail: 'sam@example.test' },
        InviteType.Household,
      );

      expect(scope).toEqual({ householdId: 'hh-1' });
      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { ...partyWhereByAddress('inv-1', ADDRESS_HOLDER_ID, 'sam@example.test'), type: InviteType.Household },
        select: { id: true, householdId: true, eventId: true },
      });
      // A read for the lock that follows, never a row lock or a write of its own.
      expect(db.invite.findFirst).not.toHaveBeenCalled();
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('binds by token as the transition does', async () => {
      tx.invite.findFirst.mockResolvedValue({ id: 'inv-1', householdId: 'hh-1', eventId: null } as never);

      await service.findPartyScopeWithin(
        asTx(tx),
        { target: { token: TOKEN }, actingUserId: STRANGER_ID },
        InviteType.Household,
      );

      expect(tx.invite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...partyWhereByToken(TOKEN, STRANGER_ID), type: InviteType.Household } }),
      );
    });

    it('reads an event invite as its event', async () => {
      tx.invite.findFirst.mockResolvedValue({ id: 'inv-1', householdId: null, eventId: 'ev-1' } as never);

      await expect(
        service.findPartyScopeWithin(
          asTx(tx),
          { target: { inviteId: 'inv-1' }, actingUserId: INVITEE_ID },
          InviteType.Event,
        ),
      ).resolves.toEqual({ eventId: 'ev-1' });
    });

    it('404s a stranger, or an invite of another type, before naming any context', async () => {
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.findPartyScopeWithin(
          asTx(tx),
          { target: { inviteId: 'inv-1' }, actingUserId: STRANGER_ID },
          InviteType.Household,
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ key: 'errors.invite.not_found' }),
      });
    });

    it('answers a household invite that names no household as the server error it is', async () => {
      tx.invite.findFirst.mockResolvedValue({ id: 'inv-1', householdId: null, eventId: null } as never);

      const refusal = service.findPartyScopeWithin(
        asTx(tx),
        { target: { inviteId: 'inv-1' }, actingUserId: INVITEE_ID },
        InviteType.Household,
      );

      await expect(refusal).rejects.toThrow('Invite inv-1 is a Household invite that names no household');
      await expect(refusal).rejects.not.toBeInstanceOf(NotFoundException);
    });
  });

  describe('receivedInviteWhere', () => {
    it('matches the invites addressed to the user by id, and none they sent', () => {
      expect(receivedInviteWhere(INVITEE_ID)).toEqual({
        inviterId: { not: INVITEE_ID },
        OR: [{ inviteeId: INVITEE_ID }],
      });
    });

    it('matches an unwithheld invite by the address the caller vouches for, as it is stored', () => {
      expect(receivedInviteWhere(ADDRESS_HOLDER_ID, ' Sam@Example.TEST ')).toEqual({
        inviterId: { not: ADDRESS_HOLDER_ID },
        OR: [{ inviteeId: ADDRESS_HOLDER_ID }, { inviteeId: null, inviteeEmail: 'sam@example.test', withheld: false }],
      });
    });
  });

  describe('createWithin', () => {
    const params = {
      type: InviteType.Household,
      inviterId: INVITER_ID,
      inviteeId: INVITEE_ID,
      householdId: 'hh-1',
      roleId: 'role-member',
    };

    beforeEach(() => {
      tx.invite.findUnique.mockResolvedValue(null);
      tx.invite.updateManyAndReturn.mockResolvedValue([] as never);
      tx.invite.create.mockResolvedValue(rowWithToken() as never);
    });

    it('refuses an invite addressed to nobody', async () => {
      await expect(service.createWithin(asTx(tx), { ...params, inviteeId: null, inviteeEmail: '  ' })).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.invite.create).not.toHaveBeenCalled();
    });

    it('refuses a self-invite', async () => {
      await expect(service.createWithin(asTx(tx), { ...params, inviteeId: INVITER_ID })).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.invite.create).not.toHaveBeenCalled();
    });

    it('refuses a household invite that names no household', async () => {
      await expect(service.createWithin(asTx(tx), { ...params, householdId: null })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses an event invite that names no event', async () => {
      await expect(
        service.createWithin(asTx(tx), { ...params, type: InviteType.Event, householdId: null, eventId: null }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a household invite that also names an event', async () => {
      // A row carrying both would sit inside both context indexes and be
      // revoked with either context.
      await expect(service.createWithin(asTx(tx), { ...params, eventId: 'ev-1' })).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ key: 'errors.invite.context_mismatch' }),
      });
      expect(tx.invite.create).not.toHaveBeenCalled();
    });

    it('refuses an event invite that also names a household', async () => {
      await expect(
        service.createWithin(asTx(tx), { ...params, type: InviteType.Event, eventId: 'ev-1' }),
      ).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ key: 'errors.invite.context_mismatch' }),
      });
    });

    it.each([InviteType.System, InviteType.Campaign])(
      'refuses a %s invite that names a household or an event',
      async (type) => {
        await expect(service.createWithin(asTx(tx), { ...params, type })).rejects.toThrow(BadRequestException);
        await expect(
          service.createWithin(asTx(tx), { ...params, type, householdId: null, eventId: 'ev-1' }),
        ).rejects.toThrow(BadRequestException);
        expect(tx.invite.create).not.toHaveBeenCalled();
      },
    );

    it('refuses an expiry that has already passed', async () => {
      await expect(service.createWithin(asTx(tx), { ...params, expiresAt: PAST })).rejects.toThrow(BadRequestException);
      expect(tx.invite.create).not.toHaveBeenCalled();
    });

    it('stamps an expired rival Expired inside the caller transaction before inserting, and hands back its event', async () => {
      // The partial unique counts a Pending row past its date as outstanding
      // until something stamps it. Left to #165's sweep, a re-invite after
      // expiry would be a 409 until the sweep ran; the create clears it first.
      const stale = { ...rowWithToken({ id: 'inv-old', expiresAt: PAST }), status: InviteStatus.Expired };
      tx.invite.updateManyAndReturn.mockResolvedValueOnce([] as never).mockResolvedValueOnce([stale] as never);

      const { expired } = await service.createWithin(asTx(tx), params);

      // AwaitingApproval before Pending: a rival approve only ever moves a row
      // the other way, so the second statement still meets it.
      expect(tx.invite.updateManyAndReturn).toHaveBeenNthCalledWith(1, {
        where: {
          householdId: 'hh-1',
          OR: [{ inviteeId: INVITEE_ID }],
          expiresAt: { lte: expect.any(Date) },
          status: InviteStatus.AwaitingApproval,
        },
        data: { status: InviteStatus.Expired },
        select: INVITE_SNAPSHOT_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenNthCalledWith(2, {
        where: {
          householdId: 'hh-1',
          OR: [{ inviteeId: INVITEE_ID }],
          expiresAt: { lte: expect.any(Date) },
          status: InviteStatus.Pending,
        },
        data: { status: InviteStatus.Expired },
        select: INVITE_SNAPSHOT_SELECT,
      });
      // On the caller's transaction, ahead of the insert, so the two commit together.
      expect(tx.invite.updateManyAndReturn.mock.invocationCallOrder[1]).toBeLessThan(
        tx.invite.create.mock.invocationCallOrder[0],
      );
      expect(db.invite.updateMany).not.toHaveBeenCalled();

      expect(expired).toHaveLength(1);
      expect(expired[0]).toBeInstanceOf(InviteExpiredEvent);
      expect(expired[0].subjectId).toBe('inv-old');
      expect(expired[0].before.status).toBe(InviteStatus.Pending);
      expect(expired[0].after.status).toBe(InviteStatus.Expired);
      expectNoToken(expired[0]);
      // Handed back with the created event, not announced: the caller emits after commit.
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('looks for rivals by the address as well when the invite carries both', async () => {
      await service.createWithin(asTx(tx), { ...params, inviteeEmail: 'Sam@Example.test' });

      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: [{ inviteeId: INVITEE_ID }, { inviteeEmail: 'sam@example.test' }] }),
        }),
      );
    });

    it('looks for rivals by the address alone on an email-only invite', async () => {
      // No invitee id means no id clause at all. `{ inviteeId: null }` would
      // match every email-only invite in the household, not this person's.
      await service.createWithin(asTx(tx), { ...params, inviteeId: null, inviteeEmail: 'sam@example.test' });

      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: [{ inviteeEmail: 'sam@example.test' }] }) }),
      );
    });

    it('stores the invitee name it is given, and no role when none is named', async () => {
      await service.createWithin(asTx(tx), {
        type: InviteType.Household,
        inviterId: INVITER_ID,
        inviteeId: INVITEE_ID,
        householdId: 'hh-1',
        inviteeName: 'Sam',
      });

      expect(tx.invite.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ inviteeName: 'Sam', roleId: null }) }),
      );
    });

    it('scopes the rival search to the event for an event invite', async () => {
      await service.createWithin(asTx(tx), { ...params, type: InviteType.Event, householdId: null, eventId: 'ev-1' });

      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ eventId: 'ev-1' }) }),
      );
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ householdId: expect.anything() }) }),
      );
    });

    it('looks for no rivals on a type no context index covers', async () => {
      await service.createWithin(asTx(tx), {
        ...params,
        type: InviteType.System,
        householdId: null,
        inviteeId: null,
        inviteeEmail: 'sam@example.test',
      });

      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
      expect(tx.invite.create).toHaveBeenCalledTimes(1);
    });

    it('mints a 43-character base64url token, probes it free, and opens the invite as Pending', async () => {
      const before = Date.now();

      await service.createWithin(asTx(tx), { ...params, inviteeEmail: '  Sam@Example.TEST ', message: 'come play' });

      const [probe] = tx.invite.findUnique.mock.calls[0] as [{ where: { token: string }; select: unknown }];
      expect(probe.where.token).toMatch(BASE64URL_43);
      expect(probe.select).toEqual({ id: true });

      const [{ data, select }] = tx.invite.create.mock.calls[0] as [
        { data: Prisma.InviteUncheckedCreateInput; select: unknown },
      ];
      expect(data.token).toBe(probe.where.token);
      expect(data.status).toBe(InviteStatus.Pending);
      expect(data.needsApproval).toBe(false);
      expect(data.inviterId).toBe(INVITER_ID);
      expect(data.inviteeId).toBe(INVITEE_ID);
      // Trimmed and lower-cased, so the email unique compares what the user
      // meant rather than how they typed it.
      expect(data.inviteeEmail).toBe('sam@example.test');
      expect(data.message).toBe('come play');
      // The default window, measured from the call.
      const expiresAt = data.expiresAt as Date;
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + DEFAULT_INVITE_TTL_MS);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + DEFAULT_INVITE_TTL_MS);
      // Reads the transition row, never the raw row.
      expect(select).toBe(TRANSITION_SELECT);
    });

    it('opens as AwaitingApproval when the context wants an approver first', async () => {
      await service.createWithin(asTx(tx), { ...params, needsApproval: true });

      const [{ data }] = tx.invite.create.mock.calls[0] as [{ data: Prisma.InviteUncheckedCreateInput }];
      expect(data.status).toBe(InviteStatus.AwaitingApproval);
      expect(data.needsApproval).toBe(true);
    });

    it('stores an invite as withheld only when the caller says so, and answers it like any other', async () => {
      const byAddress = { ...params, inviteeId: null, inviteeEmail: 'sam@example.test' };

      await service.createWithin(asTx(tx), byAddress);
      await service.createWithin(asTx(tx), { ...byAddress, withheld: true });

      const [[first], [second]] = tx.invite.create.mock.calls as [{ data: Prisma.InviteUncheckedCreateInput }][];
      expect(first.data.withheld).toBe(false);
      expect(second.data.withheld).toBe(true);
      // Same status and shape: a withheld invite is told apart by the row alone.
      expect(second.data.status).toBe(InviteStatus.Pending);
    });

    it('refuses to withhold an invite that names its invitee, who would reach it by id', async () => {
      await expect(service.createWithin(asTx(tx), { ...params, withheld: true })).rejects.toThrow('names no invitee');

      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
      expect(tx.invite.create).not.toHaveBeenCalled();
    });

    it('remints on a collision and never inserts a token the probe found taken', async () => {
      tx.invite.findUnique.mockResolvedValueOnce({ id: 'inv-existing' } as never).mockResolvedValueOnce(null);

      await service.createWithin(asTx(tx), params);

      const probed = tx.invite.findUnique.mock.calls.map(
        ([args]) => (args as { where: { token: string } }).where.token,
      );
      expect(probed).toHaveLength(2);
      expect(probed[0]).not.toBe(probed[1]);

      const [{ data }] = tx.invite.create.mock.calls[0] as [{ data: Prisma.InviteUncheckedCreateInput }];
      expect(data.token).toBe(probed[1]);
      // A warning, and never the token in it.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain(probed[0]);
    });

    it('gives up after the mint budget rather than spinning on a broken random source', async () => {
      tx.invite.findUnique.mockResolvedValue({ id: 'inv-existing' } as never);

      await expect(service.createWithin(asTx(tx), params)).rejects.toThrow(InternalServerErrorException);

      expect(tx.invite.findUnique).toHaveBeenCalledTimes(INVITE_TOKEN_MINT_ATTEMPTS);
      expect(tx.invite.create).not.toHaveBeenCalled();
    });

    it('returns the party view and a created event, neither carrying the token', async () => {
      const { invite, event, expired } = await service.createWithin(asTx(tx), params);

      expect(scalarKeysOf(invite)).toEqual(scalarKeysOf(PARTY_INVITE_SELECT));
      expect(invite).not.toHaveProperty('token');
      expect(invite.inviteeEmail).toBe('sam@example.test');

      expect(event).toBeInstanceOf(InviteCreatedEvent);
      expect(event.action).toBe('create');
      expect(event.subjectId).toBe('inv-1');
      expect(event.after.inviteeId).toBe(INVITEE_ID);
      expect(event.after.householdId).toBe('hh-1');
      expectNoToken(event);
      expect(expired).toEqual([]);
    });

    it('maps a duplicate outstanding invite to 409 by the column pair the database names', async () => {
      tx.invite.create.mockRejectedValue(uniqueViolation({ fields: ['household_id', 'invitee_id'] }));

      await expect(service.createWithin(asTx(tx), params)).rejects.toThrow(ConflictException);
    });

    it('maps the email pair and the event pairs the same way', async () => {
      for (const fields of [
        ['household_id', 'invitee_email'],
        ['event_id', 'invitee_id'],
        ['event_id', 'invitee_email'],
      ]) {
        tx.invite.create.mockRejectedValueOnce(uniqueViolation({ fields }));

        await expect(service.createWithin(asTx(tx), params)).rejects.toThrow(ConflictException);
      }
    });

    it('answers 409 with a warning when the unique cannot be identified', async () => {
      // Of the uniques this insert can reach, a duplicate outstanding invite
      // is the one that happens; the token was probed free a statement ago.
      tx.invite.create.mockRejectedValue(uniqueViolation({ omitMeta: true }));

      await expect(service.createWithin(asTx(tx), params)).rejects.toThrow(ConflictException);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('rethrows a token collision at insert as the server error it is', async () => {
      const collision = uniqueViolation({ fields: ['token'] });
      tx.invite.create.mockRejectedValue(collision);

      await expect(service.createWithin(asTx(tx), params)).rejects.toBe(collision);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('rethrows an unrelated identified unique rather than calling it a duplicate', async () => {
      const unrelated = uniqueViolation({ fields: ['id'] });
      tx.invite.create.mockRejectedValue(unrelated);

      await expect(service.createWithin(asTx(tx), params)).rejects.toBe(unrelated);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('rethrows anything that is not a unique violation untouched', async () => {
      const failure = new Error('connection reset');
      tx.invite.create.mockRejectedValue(failure);

      await expect(service.createWithin(asTx(tx), params)).rejects.toBe(failure);
    });
  });

  describe('acceptWithin', () => {
    it('reads bound to the party, guards the update on the status it read, and returns the party view', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken() as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([
        { ...rowWithToken(), status: InviteStatus.Accepted, respondedAt: FUTURE },
      ] as never);

      const { invite, event } = await service.acceptWithin(asTx(tx), {
        target: { inviteId: 'inv-1' },
        actingUserId: INVITEE_ID,
        type: InviteType.Household,
      });

      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { ...partyWhereById('inv-1', INVITEE_ID), type: InviteType.Household },
        select: TRANSITION_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: InviteStatus.Pending },
        data: { status: InviteStatus.Accepted, respondedAt: expect.any(Date), inviteeId: INVITEE_ID },
        select: INVITE_SNAPSHOT_SELECT,
      });

      expect(scalarKeysOf(invite)).toEqual(scalarKeysOf(PARTY_INVITE_SELECT));
      expect(invite.status).toBe(InviteStatus.Accepted);

      expect(event).toBeInstanceOf(InviteAcceptedEvent);
      expect(event.action).toBe('update');
      expect(event.before.status).toBe(InviteStatus.Pending);
      expect(event.after.status).toBe(InviteStatus.Accepted);
      expectNoToken(event);

      // Nothing is announced by the lib; the caller emits after commit.
      expect(emitter.emit).not.toHaveBeenCalled();
      // And nothing is written outside the caller's transaction on the happy path.
      expect(db.invite.updateMany).not.toHaveBeenCalled();
    });

    it('reaches an email-only invite by token and binds it to the acting user', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([
        { ...rowWithToken(), status: InviteStatus.Accepted, inviteeId: STRANGER_ID },
      ] as never);

      const { event } = await service.acceptWithin(asTx(tx), {
        target: { token: TOKEN },
        actingUserId: STRANGER_ID,
        type: InviteType.Household,
      });

      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { ...partyWhereByToken(TOKEN, STRANGER_ID), type: InviteType.Household },
        select: TRANSITION_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ inviteeId: STRANGER_ID }) }),
      );
      expect(event.before.inviteeId).toBeNull();
      expect(event.after.inviteeId).toBe(STRANGER_ID);
    });

    it('reaches an invite by address by its id when the caller vouches for that address, and binds it', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([
        { ...rowWithToken(), status: InviteStatus.Accepted, inviteeId: ADDRESS_HOLDER_ID },
      ] as never);

      const { event } = await service.acceptWithin(asTx(tx), {
        target: { inviteId: 'inv-1' },
        actingUserId: ADDRESS_HOLDER_ID,
        vouchedEmail: ' Sam@Example.TEST ',
        type: InviteType.Household,
      });

      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { ...partyWhereByAddress('inv-1', ADDRESS_HOLDER_ID, 'sam@example.test'), type: InviteType.Household },
        select: TRANSITION_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ inviteeId: ADDRESS_HOLDER_ID }) }),
      );
      expect(event.before.inviteeId).toBeNull();
      expect(event.after.inviteeId).toBe(ADDRESS_HOLDER_ID);
    });

    it('adds no address to the read when the caller vouches for none', async () => {
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          vouchedEmail: '  ',
          type: InviteType.Household,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(tx.invite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...partyWhereById('inv-1', INVITEE_ID), type: InviteType.Household } }),
      );
    });

    it('403s an invite by address whose address is not the one vouched for', async () => {
      // The read's address branch never returns such a row; this is the role
      // check standing behind it, as it stands behind the token.
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: ADDRESS_HOLDER_ID,
          vouchedEmail: 'someone-else@example.test',
          type: InviteType.Household,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('403s the inviter even when the address vouched for is the one on their invite', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITER_ID,
          vouchedEmail: 'sam@example.test',
          type: InviteType.Household,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('404s an unknown id', async () => {
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-missing' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('404s an unknown token without echoing it', async () => {
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { token: TOKEN },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ key: 'errors.invite.link_not_found' }),
      });
    });

    it('404s a stranger: the party-bound read never finds a row that is not theirs', async () => {
      // The where carries the binding, so the mock's miss IS the stranger's
      // answer. A 403 would confirm the invite exists to someone it is not for.
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: STRANGER_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(tx.invite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...partyWhereById('inv-1', STRANGER_ID), type: InviteType.Household } }),
      );
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('403s the inviter, who is a party but not the one who answers', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status: InviteStatus.Declined }) as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITER_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(ForbiddenException);
      // Role is refused before the status is mentioned.
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('403s an email-only invite addressed by id, even to its inviter: only its link reaches it', async () => {
      // The id is public to every context reader through the household detail.
      // If it reached an email-only invite, anyone who could see the household
      // could accept on the invitee's behalf.
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITER_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('403s the inviter answering their own email-only invite by its link', async () => {
      // Create refuses a self-invite by id, but cannot see that an address is
      // the inviter's own. The link reaches the row; the role check still
      // says the inviter never answers.
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { token: TOKEN },
          actingUserId: INVITER_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('409s an invite still awaiting approval, naming that rather than "settled"', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status: InviteStatus.AwaitingApproval }) as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.invite.awaiting_approval' }),
      });
    });

    it.each(TERMINAL)('409s a settled invite (%s)', async (status) => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.invite.not_outstanding', args: { id: 'inv-1', status } }),
      });
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('410s an expired invite, stamping Expired OUTSIDE the caller transaction and announcing it', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);
      db.invite.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(GoneException);
      await settled();

      // The refusal rolls the caller's transaction back, so the stamp lives on
      // the lib's own connection, guarded on the status and date it was read in.
      expect(tx.invite.updateMany).not.toHaveBeenCalled();
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
      expect(db.invite.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv-1', status: InviteStatus.Pending, expiresAt: { lte: expect.any(Date) } },
        data: { status: InviteStatus.Expired },
      });

      // Already committed, so announced at once.
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      const [name, event] = emitter.emit.mock.calls[0] as [string, InviteExpiredEvent];
      expect(name).toBe(InviteEvents.Expired);
      expect(event).toBeInstanceOf(InviteExpiredEvent);
      expect(event.before.status).toBe(InviteStatus.Pending);
      expect(event.after.status).toBe(InviteStatus.Expired);
      expectNoToken(event);
    });

    it('refuses without waiting on the stamp: the request holds a transaction connection the stamp cannot share', async () => {
      // If the refusal awaited a second connection while the caller's
      // transaction held the first, a pool full of such requests would wait
      // on itself until the pool timeout. This test would time out the same way.
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);
      db.invite.updateMany.mockReturnValue(never() as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(GoneException);
    });

    it('still answers 410 when the stamp fails, and logs the failure', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);
      db.invite.updateMany.mockRejectedValue(new Error('pool exhausted'));

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(GoneException);
      await settled();

      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain('inv-1');
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('410s an expired invite without announcing when something else stamped it first', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);
      db.invite.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(GoneException);
      await settled();

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('reports the transition the row now refuses when a rival moved it first', async () => {
      // Read Pending; the guarded update misses because a rival accept
      // committed in between. The re-read says Accepted, and that is the
      // answer, not a generic "try again".
      tx.invite.findFirst
        .mockResolvedValueOnce(rowWithToken() as never)
        .mockResolvedValueOnce(rowWithToken({ status: InviteStatus.Accepted }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([] as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          key: 'errors.invite.not_outstanding',
          args: { id: 'inv-1', status: InviteStatus.Accepted },
        }),
      });
      // The re-read is by id alone; the party was established by the first read.
      expect(tx.invite.findFirst).toHaveBeenNthCalledWith(2, { where: { id: 'inv-1' }, select: TRANSITION_SELECT });
    });

    it('asks for a retry only when the re-read row would still allow the transition', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken() as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([] as never);

      await expect(
        service.acceptWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.invite.changed_concurrently' }),
      });
    });
  });

  describe('findAcceptableWithin', () => {
    const lookup = { target: { inviteId: 'inv-1' }, actingUserId: INVITEE_ID, type: InviteType.Household } as const;

    it('reads as accept reads, writes nothing, and hands back who sent the invite and what it offers', async () => {
      tx.invite.findFirst.mockResolvedValue({ ...rowWithToken(), needsApproval: false } as never);

      const offer = await service.findAcceptableWithin(asTx(tx), lookup);

      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { ...partyWhereById('inv-1', INVITEE_ID), type: InviteType.Household },
        select: { ...TRANSITION_SELECT, needsApproval: true },
      });
      expect(offer).toEqual({
        id: 'inv-1',
        inviterId: INVITER_ID,
        role: { id: 'role-member', name: 'HouseholdMember' },
        needsApproval: false,
      });
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
      expect(db.invite.updateMany).not.toHaveBeenCalled();
    });

    it('says an invite was sent to wait for an approver, as its row stores it (#747)', async () => {
      tx.invite.findFirst.mockResolvedValue({ ...rowWithToken(), needsApproval: true } as never);

      await expect(service.findAcceptableWithin(asTx(tx), lookup)).resolves.toMatchObject({ needsApproval: true });
    });

    // The consumer asks its own question of the offer only once the lib would
    // have let the accept through, so every refusal the accept makes comes
    // first, and comes out the same (#747).
    it.each([
      ['a stranger', null, INVITEE_ID],
      ['the inviter', rowWithToken(), INVITER_ID],
      ['an invite awaiting approval', rowWithToken({ status: InviteStatus.AwaitingApproval }), INVITEE_ID],
      ...TERMINAL.map((status) => [`a ${status} invite`, rowWithToken({ status }), INVITEE_ID] as const),
      ['an expired invite', rowWithToken({ expiresAt: PAST }), INVITEE_ID],
    ] as const)('refuses %s exactly as acceptWithin does', async (_case, row, actingUserId) => {
      const refusalOf = (refusal: HttpException) => ({ status: refusal.getStatus(), response: refusal.getResponse() });
      db.invite.updateMany.mockResolvedValue({ count: 0 });

      tx.invite.findFirst.mockResolvedValue(row as never);
      const accepted = await service.acceptWithin(asTx(tx), { ...lookup, actingUserId }).then(() => null, refusalOf);

      tx.invite.findFirst.mockResolvedValue(row === null ? null : ({ ...row, needsApproval: false } as never));
      const found = await service
        .findAcceptableWithin(asTx(tx), { ...lookup, actingUserId })
        .then(() => null, refusalOf);

      expect(accepted).not.toBeNull();
      expect(found).toEqual(accepted);
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });
  });

  describe('declineWithin', () => {
    it.each([InviteStatus.Pending, InviteStatus.AwaitingApproval])('declines from %s', async (status) => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([
        { ...rowWithToken(), status: InviteStatus.Declined, respondedAt: FUTURE },
      ] as never);

      const { invite, event } = await service.declineWithin(asTx(tx), {
        target: { inviteId: 'inv-1' },
        actingUserId: INVITEE_ID,
        type: InviteType.Household,
      });

      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1', status },
          data: expect.objectContaining({
            status: InviteStatus.Declined,
            respondedAt: expect.any(Date),
            inviteeId: INVITEE_ID,
          }),
        }),
      );
      expect(invite.status).toBe(InviteStatus.Declined);
      expect(event).toBeInstanceOf(InviteDeclinedEvent);
      // The status the row actually left, not a guess from the allowed set.
      expect(event.before.status).toBe(status);
      expectNoToken(event);
    });

    it.each(TERMINAL)('409s a settled invite (%s)', async (status) => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);

      await expect(
        service.declineWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('410s an expired invite', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);
      db.invite.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.declineWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(GoneException);
    });

    it('declines an invite by address by its id when the caller vouches for that address', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([
        { ...rowWithToken(), status: InviteStatus.Declined, inviteeId: ADDRESS_HOLDER_ID },
      ] as never);

      await service.declineWithin(asTx(tx), {
        target: { inviteId: 'inv-1' },
        actingUserId: ADDRESS_HOLDER_ID,
        vouchedEmail: 'sam@example.test',
        type: InviteType.Household,
      });

      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { ...partyWhereByAddress('inv-1', ADDRESS_HOLDER_ID, 'sam@example.test'), type: InviteType.Household },
        select: TRANSITION_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ inviteeId: ADDRESS_HOLDER_ID }) }),
      );
    });

    it('403s the inviter', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken() as never);

      await expect(
        service.declineWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITER_ID,
          type: InviteType.Household,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('404s an invite of another type: the read binds the type the consumer handles', async () => {
      // The where carries the type, so the mock's miss IS the answer an event
      // invite gets at a household route.
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.declineWithin(asTx(tx), {
          target: { inviteId: 'inv-1' },
          actingUserId: INVITEE_ID,
          type: InviteType.Event,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(tx.invite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...partyWhereById('inv-1', INVITEE_ID), type: InviteType.Event } }),
      );
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });
  });

  describe('withdrawWithin', () => {
    it.each([InviteStatus.Pending, InviteStatus.AwaitingApproval])('withdraws from %s', async (status) => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([
        { ...rowWithToken(), status: InviteStatus.Withdrawn, respondedAt: FUTURE },
      ] as never);

      const { invite, event } = await service.withdrawWithin(asTx(tx), {
        inviteId: 'inv-1',
        actingUserId: INVITER_ID,
        type: InviteType.Household,
      });

      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { ...partyWhereById('inv-1', INVITER_ID), type: InviteType.Household },
        select: TRANSITION_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1', status },
          data: { status: InviteStatus.Withdrawn, respondedAt: expect.any(Date) },
        }),
      );
      expect(scalarKeysOf(invite)).toEqual(scalarKeysOf(PARTY_INVITE_SELECT));
      expect(event).toBeInstanceOf(InviteWithdrawnEvent);
      expect(event.before.status).toBe(status);
      expectNoToken(event);
    });

    it.each(TERMINAL)('409s a settled invite (%s)', async (status) => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);

      await expect(
        service.withdrawWithin(asTx(tx), { inviteId: 'inv-1', actingUserId: INVITER_ID, type: InviteType.Household }),
      ).rejects.toThrow(ConflictException);
    });

    it('410s an expired invite', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);
      db.invite.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.withdrawWithin(asTx(tx), { inviteId: 'inv-1', actingUserId: INVITER_ID, type: InviteType.Household }),
      ).rejects.toThrow(GoneException);
    });

    it('403s the invitee', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken() as never);

      await expect(
        service.withdrawWithin(asTx(tx), { inviteId: 'inv-1', actingUserId: INVITEE_ID, type: InviteType.Household }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('withdraws an email-only invite: the inviter needs no invitee to bind to', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ inviteeId: null }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([
        { ...rowWithToken({ inviteeId: null }), status: InviteStatus.Withdrawn },
      ] as never);

      const { invite } = await service.withdrawWithin(asTx(tx), {
        inviteId: 'inv-1',
        actingUserId: INVITER_ID,
        type: InviteType.Household,
      });

      expect(invite.status).toBe(InviteStatus.Withdrawn);
    });

    it('404s an invite of another type: the read binds the type the consumer handles', async () => {
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.withdrawWithin(asTx(tx), { inviteId: 'inv-1', actingUserId: INVITER_ID, type: InviteType.Event }),
      ).rejects.toThrow(NotFoundException);
      expect(tx.invite.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...partyWhereById('inv-1', INVITER_ID), type: InviteType.Event } }),
      );
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });
  });

  describe('revokeWithin', () => {
    const scope = { householdId: 'hh-1' };
    const REVOKER_ID = 'user-admin';

    it.each([InviteStatus.Pending, InviteStatus.AwaitingApproval])(
      'revokes from %s, bound to the authorized household and to no party, and returns the context view',
      async (status) => {
        tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);
        tx.invite.updateManyAndReturn.mockResolvedValue([
          { ...rowWithToken(), status: InviteStatus.Revoked, respondedAt: FUTURE },
        ] as never);

        const { invite, event } = await service.revokeWithin(asTx(tx), {
          inviteId: 'inv-1',
          revokerId: REVOKER_ID,
          scope,
        });

        // The caller asserted the context authority; the read carries the
        // context that assertion covered, and binds to no party.
        expect(tx.invite.findFirst).toHaveBeenCalledWith({
          where: { id: 'inv-1', householdId: 'hh-1' },
          select: TRANSITION_SELECT,
        });
        expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'inv-1', status },
            data: { status: InviteStatus.Revoked, respondedAt: expect.any(Date) },
          }),
        );
        // A revoker is not a party: no address, no message.
        expect(scalarKeysOf(invite)).toEqual(scalarKeysOf(CONTEXT_INVITE_SELECT));
        expect(invite).not.toHaveProperty('inviteeEmail');
        expect(invite).not.toHaveProperty('message');
        expect(event).toBeInstanceOf(InviteRevokedEvent);
        expect(event.before.status).toBe(status);
        expectNoToken(event);
      },
    );

    it.each(TERMINAL)('409s a settled invite (%s)', async (status) => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);

      await expect(service.revokeWithin(asTx(tx), { inviteId: 'inv-1', revokerId: REVOKER_ID, scope })).rejects.toThrow(
        ConflictException,
      );
    });

    it('410s an expired invite rather than revoking it', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);
      db.invite.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.revokeWithin(asTx(tx), { inviteId: 'inv-1', revokerId: REVOKER_ID, scope })).rejects.toThrow(
        GoneException,
      );
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it('404s an id outside the authorized household: the scope is in the query, so the row is never found', async () => {
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.revokeWithin(asTx(tx), {
          inviteId: 'inv-1',
          revokerId: REVOKER_ID,
          scope: { householdId: 'hh-other' },
        }),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ key: 'errors.invite.not_found', args: { id: 'inv-1' } }),
      });
      // The same miss an unknown id meets: nothing confirms the other household's invite exists.
      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { id: 'inv-1', householdId: 'hh-other' },
        select: TRANSITION_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    it.each([InviteStatus.Pending, InviteStatus.AwaitingApproval, InviteStatus.Revoked])(
      "403s the invite's own inviter (%s), who withdraws it instead, and moves nothing",
      async (status) => {
        tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);

        await expect(
          service.revokeWithin(asTx(tx), { inviteId: 'inv-1', revokerId: INVITER_ID, scope }),
        ).rejects.toMatchObject({
          status: 403,
          response: expect.objectContaining({ key: 'errors.invite.revoke_own_invite', args: { id: 'inv-1' } }),
        });
        expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
      },
    );

    it("403s the inviter before an expiry is stamped: the refusal is about who asks, not the invite's state", async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ expiresAt: PAST }) as never);

      await expect(service.revokeWithin(asTx(tx), { inviteId: 'inv-1', revokerId: INVITER_ID, scope })).rejects.toThrow(
        ForbiddenException,
      );
      await settled();
      expect(db.invite.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('approveWithin', () => {
    const scope = { householdId: 'hh-1' };

    it('opens an AwaitingApproval invite to its invitee, stamping the approver', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status: InviteStatus.AwaitingApproval }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([{ ...rowWithToken(), status: InviteStatus.Pending }] as never);

      const { invite, event } = await service.approveWithin(asTx(tx), {
        inviteId: 'inv-1',
        approverId: 'user-admin',
        scope,
      });

      // Bound to the context the approver's authority covers, as a revoke is.
      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { id: 'inv-1', householdId: 'hh-1' },
        select: TRANSITION_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'inv-1', status: InviteStatus.AwaitingApproval },
          data: { status: InviteStatus.Pending, approvedById: 'user-admin', approvedAt: expect.any(Date) },
        }),
      );
      expect(scalarKeysOf(invite)).toEqual(scalarKeysOf(CONTEXT_INVITE_SELECT));
      expect(event).toBeInstanceOf(InviteApprovedEvent);
      expect(event.before.status).toBe(InviteStatus.AwaitingApproval);
      expect(event.after.status).toBe(InviteStatus.Pending);
      expectNoToken(event);
    });

    it('restarts the invitee window when given one, so the wait for an approver does not shorten it', async () => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status: InviteStatus.AwaitingApproval }) as never);
      tx.invite.updateManyAndReturn.mockResolvedValue([{ ...rowWithToken(), status: InviteStatus.Pending }] as never);
      const expiresAt = new Date(Date.now() + 60_000);

      await service.approveWithin(asTx(tx), { inviteId: 'inv-1', approverId: 'user-admin', scope, expiresAt });

      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: InviteStatus.Pending, expiresAt }) }),
      );
    });

    it('400s a window that has already closed, and reads nothing', async () => {
      await expect(
        service.approveWithin(asTx(tx), { inviteId: 'inv-1', approverId: 'user-admin', scope, expiresAt: PAST }),
      ).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ key: 'errors.invite.expires_in_past' }),
      });
      expect(tx.invite.findFirst).not.toHaveBeenCalled();
    });

    it.each([InviteStatus.Pending, ...TERMINAL])('409s an invite that is %s, not awaiting approval', async (status) => {
      tx.invite.findFirst.mockResolvedValue(rowWithToken({ status }) as never);

      await expect(
        service.approveWithin(asTx(tx), { inviteId: 'inv-1', approverId: 'user-admin', scope }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ key: 'errors.invite.not_awaiting_approval' }),
      });
    });

    it('410s an expired invite rather than approving it', async () => {
      tx.invite.findFirst.mockResolvedValue(
        rowWithToken({ status: InviteStatus.AwaitingApproval, expiresAt: PAST }) as never,
      );
      db.invite.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.approveWithin(asTx(tx), { inviteId: 'inv-1', approverId: 'user-admin', scope }),
      ).rejects.toThrow(GoneException);
      expect(db.invite.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: InviteStatus.AwaitingApproval }) }),
      );
    });

    it('binds the read to an event scope as well, and 404s an id outside it', async () => {
      tx.invite.findFirst.mockResolvedValue(null);

      await expect(
        service.approveWithin(asTx(tx), { inviteId: 'inv-1', approverId: 'user-admin', scope: { eventId: 'ev-1' } }),
      ).rejects.toMatchObject({
        status: 404,
        response: expect.objectContaining({ key: 'errors.invite.not_found', args: { id: 'inv-1' } }),
      });
      expect(tx.invite.findFirst).toHaveBeenCalledWith({
        where: { id: 'inv-1', eventId: 'ev-1' },
        select: TRANSITION_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });
  });

  describe('revokeOutstandingWithin', () => {
    it('revokes AwaitingApproval rows and then Pending rows for the household, one guarded statement each', async () => {
      const awaiting = { ...rowWithToken({ id: 'inv-a' }), status: InviteStatus.Revoked, respondedAt: FUTURE };
      const pending = { ...rowWithToken({ id: 'inv-p' }), status: InviteStatus.Revoked, respondedAt: FUTURE };
      tx.invite.updateManyAndReturn
        .mockResolvedValueOnce([awaiting] as never)
        .mockResolvedValueOnce([pending] as never);

      const { count, events } = await service.revokeOutstandingWithin(asTx(tx), { householdId: 'hh-1' });

      // AwaitingApproval first. A rival approve moves a row from
      // AwaitingApproval to Pending and never back, so a row that slips past
      // the first statement is Pending by the second and is still caught.
      // The other order would let it through as an outstanding invite into a
      // deleted household.
      expect(tx.invite.updateManyAndReturn).toHaveBeenNthCalledWith(1, {
        where: { householdId: 'hh-1', status: InviteStatus.AwaitingApproval },
        data: { status: InviteStatus.Revoked, respondedAt: expect.any(Date) },
        select: INVITE_SNAPSHOT_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenNthCalledWith(2, {
        where: { householdId: 'hh-1', status: InviteStatus.Pending },
        data: { status: InviteStatus.Revoked, respondedAt: expect.any(Date) },
        select: INVITE_SNAPSHOT_SELECT,
      });

      expect(count).toBe(2);
      expect(events.map((event) => event.subjectId)).toEqual(['inv-a', 'inv-p']);
      // Each domain event carries the status its row left.
      expect(events[0].before.status).toBe(InviteStatus.AwaitingApproval);
      expect(events[1].before.status).toBe(InviteStatus.Pending);
      expect(events.every((event) => event instanceof InviteRevokedEvent)).toBe(true);
      expect(events.every((event) => event.after.status === InviteStatus.Revoked)).toBe(true);
      events.forEach(expectNoToken);

      // Handed back, not announced: the caller emits after commit.
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('reports nothing when nothing was outstanding', async () => {
      tx.invite.updateManyAndReturn.mockResolvedValue([] as never);

      await expect(service.revokeOutstandingWithin(asTx(tx), { householdId: 'hh-1' })).resolves.toEqual({
        count: 0,
        events: [],
      });
    });

    it('scopes by event as well', async () => {
      tx.invite.updateManyAndReturn.mockResolvedValue([] as never);

      await service.revokeOutstandingWithin(asTx(tx), { eventId: 'ev-1' });

      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'ev-1', status: InviteStatus.Pending } }),
      );
    });
  });

  describe('revokeOutstandingOfUserWithin', () => {
    const DEPARTED_ID = 'user-departed';
    const ofDeparted = { OR: [{ inviterId: DEPARTED_ID }, { inviteeId: DEPARTED_ID }] };

    it("revokes the context's outstanding invites the user sent or that name them by id, AwaitingApproval first", async () => {
      const sent = { ...rowWithToken({ id: 'inv-sent', inviterId: DEPARTED_ID }), status: InviteStatus.Revoked };
      const named = { ...rowWithToken({ id: 'inv-named', inviteeId: DEPARTED_ID }), status: InviteStatus.Revoked };
      tx.invite.updateManyAndReturn.mockResolvedValueOnce([sent] as never).mockResolvedValueOnce([named] as never);

      const { count, events } = await service.revokeOutstandingOfUserWithin(
        asTx(tx),
        { householdId: 'hh-1' },
        DEPARTED_ID,
      );

      // Invites to the user's address are not in the `where` at all: revoking
      // them would tell each inviter whose address it was (#747).
      expect(tx.invite.updateManyAndReturn).toHaveBeenNthCalledWith(1, {
        where: { householdId: 'hh-1', ...ofDeparted, status: InviteStatus.AwaitingApproval },
        data: { status: InviteStatus.Revoked, respondedAt: expect.any(Date) },
        select: INVITE_SNAPSHOT_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenNthCalledWith(2, {
        where: { householdId: 'hh-1', ...ofDeparted, status: InviteStatus.Pending },
        data: { status: InviteStatus.Revoked, respondedAt: expect.any(Date) },
        select: INVITE_SNAPSHOT_SELECT,
      });

      expect(count).toBe(2);
      expect(events.map((event) => event.subjectId)).toEqual(['inv-sent', 'inv-named']);
      expect(events[0].before.status).toBe(InviteStatus.AwaitingApproval);
      expect(events[1].before.status).toBe(InviteStatus.Pending);
      expect(events.every((event) => event instanceof InviteRevokedEvent)).toBe(true);
      events.forEach(expectNoToken);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('reports nothing when the user had nothing outstanding there', async () => {
      tx.invite.updateManyAndReturn.mockResolvedValue([] as never);

      await expect(
        service.revokeOutstandingOfUserWithin(asTx(tx), { householdId: 'hh-1' }, DEPARTED_ID),
      ).resolves.toEqual({ count: 0, events: [] });
    });
  });

  describe('expireOutstandingWithin', () => {
    const LIMIT = 500;
    const expiredRow = (overrides: Partial<InviteTransitionRow>) => ({
      ...rowWithToken({ expiresAt: PAST, ...overrides }),
      status: InviteStatus.Expired,
    });

    it('expires overdue AwaitingApproval rows and then Pending rows of every type, each read capped at the limit', async () => {
      const awaiting = expiredRow({ id: 'inv-a' });
      const system = expiredRow({ id: 'inv-s', type: InviteType.System, householdId: null });
      tx.invite.findMany
        .mockResolvedValueOnce([{ id: 'inv-a' }] as never)
        .mockResolvedValueOnce([{ id: 'inv-s' }] as never);
      tx.invite.updateManyAndReturn.mockResolvedValueOnce([awaiting] as never).mockResolvedValueOnce([system] as never);

      const startedAt = Date.now();
      const { count, events, drained } = await service.expireOutstandingWithin(asTx(tx), { limit: LIMIT });
      const boundary = events[0].initiatedAt;

      // `lte`, as effectiveInviteStatus calls a row at exactly `expiresAt`
      // expired, measured at the moment of the call. No context or type in the
      // `where`: the sweep covers System and Campaign invites too.
      expect(boundary.getTime()).toBeGreaterThanOrEqual(startedAt);
      expect(boundary.getTime()).toBeLessThanOrEqual(Date.now());
      expect(tx.invite.findMany).toHaveBeenNthCalledWith(1, {
        where: { expiresAt: { lte: boundary }, status: InviteStatus.AwaitingApproval },
        select: { id: true },
        take: LIMIT,
      });
      expect(tx.invite.findMany).toHaveBeenNthCalledWith(2, {
        where: { expiresAt: { lte: boundary }, status: InviteStatus.Pending },
        select: { id: true },
        take: LIMIT,
      });
      // Status only: nobody responded.
      expect(tx.invite.updateManyAndReturn).toHaveBeenNthCalledWith(1, {
        where: { expiresAt: { lte: boundary }, status: InviteStatus.AwaitingApproval, id: { in: ['inv-a'] } },
        data: { status: InviteStatus.Expired },
        select: INVITE_SNAPSHOT_SELECT,
      });
      expect(tx.invite.updateManyAndReturn).toHaveBeenNthCalledWith(2, {
        where: { expiresAt: { lte: boundary }, status: InviteStatus.Pending, id: { in: ['inv-s'] } },
        data: { status: InviteStatus.Expired },
        select: INVITE_SNAPSHOT_SELECT,
      });
      // AwaitingApproval first, for the reason revokeOutstandingWithin gives.
      const [readAwaiting, readPending] = tx.invite.findMany.mock.invocationCallOrder;
      const [writeAwaiting, writePending] = tx.invite.updateManyAndReturn.mock.invocationCallOrder;
      expect([readAwaiting, writeAwaiting, readPending, writePending]).toEqual(
        [readAwaiting, writeAwaiting, readPending, writePending].sort((a, b) => a - b),
      );
      // All of it on the caller's transaction.
      expect(db.invite.findMany).not.toHaveBeenCalled();
      expect(db.invite.updateManyAndReturn).not.toHaveBeenCalled();

      expect(count).toBe(2);
      // Both reads came back under the limit, so nothing overdue was left.
      expect(drained).toBe(true);
      expect(events.map((event) => event.subjectId)).toEqual(['inv-a', 'inv-s']);
      expect(events[0].before.status).toBe(InviteStatus.AwaitingApproval);
      expect(events[1].before.status).toBe(InviteStatus.Pending);
      expect(events.every((event) => event instanceof InviteExpiredEvent)).toBe(true);
      expect(events.every((event) => event.after.status === InviteStatus.Expired)).toBe(true);
      expect(events.every((event) => event.after.respondedAt === null)).toBe(true);
      events.forEach(expectNoToken);

      // Handed back, not announced: the caller emits after commit.
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("re-states the guard on the write rather than using Prisma's own limit, so a row a rival settled is left alone", async () => {
      // Prisma's own `limit` keeps the guard out of the write's outer `where`
      // (settleOutstandingWithin says why that loses a rival's transition).
      tx.invite.findMany
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([{ id: 'inv-1' }, { id: 'inv-raced' }] as never);
      tx.invite.updateManyAndReturn.mockResolvedValueOnce([expiredRow({ id: 'inv-1' })] as never);

      const { count, events } = await service.expireOutstandingWithin(asTx(tx), { limit: LIMIT });

      expect(tx.invite.updateManyAndReturn).toHaveBeenCalledTimes(1);
      const [{ where, ...rest }] = tx.invite.updateManyAndReturn.mock.calls[0] as [
        Prisma.InviteUpdateManyAndReturnArgs,
      ];
      expect(where).toEqual({
        expiresAt: { lte: expect.any(Date) },
        status: InviteStatus.Pending,
        id: { in: ['inv-1', 'inv-raced'] },
      });
      expect(rest).not.toHaveProperty('limit');

      expect(count).toBe(1);
      expect(events.map((event) => event.subjectId)).toEqual(['inv-1']);
    });

    it('reports more to come when a read came back full, even though a rival left the write short', async () => {
      // A count under the limit would read as "ran out" here, and a caller
      // stopping on it would leave the rest of a backlog for another hour.
      tx.invite.findMany
        .mockResolvedValueOnce([{ id: 'inv-1' }, { id: 'inv-raced' }] as never)
        .mockResolvedValueOnce([] as never);
      tx.invite.updateManyAndReturn.mockResolvedValueOnce([expiredRow({ id: 'inv-1' })] as never);

      const { count, drained } = await service.expireOutstandingWithin(asTx(tx), { limit: 2 });

      expect(count).toBe(1);
      expect(drained).toBe(false);
    });

    it('writes nothing for a status with nothing overdue', async () => {
      tx.invite.findMany.mockResolvedValue([] as never);

      await expect(service.expireOutstandingWithin(asTx(tx), { limit: LIMIT })).resolves.toEqual({
        count: 0,
        events: [],
        drained: true,
      });
      expect(tx.invite.findMany).toHaveBeenCalledTimes(2);
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });

    /**
     * A stand-in table both statements really read and write, so what a later
     * call finds follows from the earlier calls' writes rather than from a
     * stubbed answer.
     */
    const useTable = <Row extends { id: string; status: InviteStatus; expiresAt: Date }>(table: Row[]) => {
      type Where = { status: InviteStatus; expiresAt: { lte: Date }; id?: { in: string[] } };
      const matching = (where: Where) =>
        table.filter(
          (row) =>
            row.status === where.status &&
            row.expiresAt <= where.expiresAt.lte &&
            (!where.id || where.id.in.includes(row.id)),
        );
      tx.invite.findMany.mockImplementation((async ({ where, take }: { where: Where; take: number }) =>
        matching(where)
          .slice(0, take)
          .map(({ id }) => ({ id }))) as never);
      tx.invite.updateManyAndReturn.mockImplementation((async ({ where, data }: { where: Where; data: object }) =>
        matching(where).map((row) => ({ ...Object.assign(row, data) }))) as never);

      return table;
    };

    it('matches nothing on a second run, and leaves live and settled rows alone', async () => {
      const table = useTable([
        rowWithToken({ id: 'inv-overdue', expiresAt: PAST }),
        { ...rowWithToken({ id: 'inv-awaiting', expiresAt: PAST }), status: InviteStatus.AwaitingApproval },
        rowWithToken({ id: 'inv-live', expiresAt: FUTURE }),
        { ...rowWithToken({ id: 'inv-declined', expiresAt: PAST }), status: InviteStatus.Declined },
      ]);

      const first = await service.expireOutstandingWithin(asTx(tx), { limit: LIMIT });
      const second = await service.expireOutstandingWithin(asTx(tx), { limit: LIMIT });

      expect(first.events.map((event) => event.subjectId)).toEqual(['inv-awaiting', 'inv-overdue']);
      expect(first.drained).toBe(true);
      expect(second).toEqual({ count: 0, events: [], drained: true });
      expect(Object.fromEntries(table.map((row) => [row.id, row.status]))).toEqual({
        'inv-overdue': InviteStatus.Expired,
        'inv-awaiting': InviteStatus.Expired,
        'inv-live': InviteStatus.Pending,
        'inv-declined': InviteStatus.Declined,
      });
    });

    it('drains a backlog over several calls, saying drained only once a read comes back short', async () => {
      useTable([
        rowWithToken({ id: 'inv-1', expiresAt: PAST }),
        rowWithToken({ id: 'inv-2', expiresAt: PAST }),
        rowWithToken({ id: 'inv-3', expiresAt: PAST }),
      ]);
      const call = async () => {
        const { count, drained } = await service.expireOutstandingWithin(asTx(tx), { limit: 2 });

        return { count, drained };
      };

      // The second call's read is short, so a caller stops there; a third
      // would find nothing.
      expect(await call()).toEqual({ count: 2, drained: false });
      expect(await call()).toEqual({ count: 1, drained: true });
      expect(await call()).toEqual({ count: 0, drained: true });
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses a limit of %s, which would stop no batch loop', async (limit) => {
      await expect(service.expireOutstandingWithin(asTx(tx), { limit })).rejects.toThrow(
        'The expiry limit must be a positive integer',
      );
      expect(tx.invite.findMany).not.toHaveBeenCalled();
      expect(tx.invite.updateManyAndReturn).not.toHaveBeenCalled();
    });
  });

  describe('emit', () => {
    const created = () => new InviteCreatedEvent({ ...transitionRow() }, PAST);
    const revoked = () =>
      new InviteRevokedEvent(transitionRow(), { ...transitionRow(), status: InviteStatus.Revoked }, PAST);

    it('announces each domain event under its lifecycle name', () => {
      const first = created();
      const second = revoked();

      service.emit([first, second]);

      expect(emitter.emit).toHaveBeenNthCalledWith(1, InviteEvents.Created, first);
      expect(emitter.emit).toHaveBeenNthCalledWith(2, InviteEvents.Revoked, second);
    });

    it('logs a throwing listener and still announces the rest', () => {
      // EventEmitterModule runs without `ignoreErrors`; a sync listener's throw
      // would otherwise turn a committed transition into a failed request.
      emitter.emit.mockImplementationOnce(() => {
        throw new Error('listener exploded');
      });

      expect(() => service.emit([created(), revoked()])).not.toThrow();

      expect(emitter.emit).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('is a no-op on an empty list', () => {
      service.emit([]);

      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
