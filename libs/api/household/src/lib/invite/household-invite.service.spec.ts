import { Action, InviteStatus, InviteType, Prisma, ResourceType, SystemRole } from '@bge/database';
import {
  CONTEXT_INVITE_SELECT,
  InviteService,
  type InviteContextView,
  type InviteCreation,
  type InvitePartyView,
} from '@bge/invites';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { CreateHouseholdInviteDto, ListHouseholdInvitesQueryDto } from '../dto';
import { HouseholdInviteService } from './household-invite.service';

const COND = { id: 'sentinel-condition' };
/** Only a person is an invitee: neither the service account nor an anonymous guest. */
const PERSON = { isServiceAccount: false, OR: [{ isAnonymous: false }, { isAnonymous: null }] };
const NOW = new Date('2026-10-13T12:00:00Z');
const LATER = new Date('2026-10-20T12:00:00Z');
const EARLIER = new Date('2026-10-10T12:00:00Z');

type RosterRow = { userId: string; role: { role: { name: string } } | null };

const rosterRow = (userId: string, name: SystemRole): RosterRow => ({ userId, role: { role: { name } } });

const ROSTER: RosterRow[] = [
  rosterRow('owner-1', SystemRole.HouseholdOwner),
  rosterRow('member-1', SystemRole.HouseholdMember),
];

const contextView = (overrides: Partial<InviteContextView> = {}): InviteContextView => ({
  id: 'invite-1',
  status: InviteStatus.Pending,
  type: InviteType.Household,
  inviteeName: 'Sam',
  expiresAt: LATER,
  createdAt: NOW,
  role: { id: 'role-member', name: SystemRole.HouseholdMember },
  inviter: { id: 'owner-1', username: 'owner', profile: null },
  ...overrides,
});

const partyView = (overrides: Partial<InvitePartyView> = {}): InvitePartyView => ({
  ...contextView(),
  inviteeEmail: 'sam@example.test',
  message: 'Join us',
  ...overrides,
});

/** Prisma's delegate types want full rows; the service selects narrower ones. */
const resolves = (value: unknown) => value as never;

describe('HouseholdInviteService', () => {
  let service: HouseholdInviteService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<AbilityService, 'getActingUserId' | 'assertCurrentActorCan' | 'getCurrentResourceConditions'>
  >;
  let invites: jest.Mocked<Pick<InviteService, 'createWithin' | 'emit'>>;
  let creation: InviteCreation;

  beforeEach(async () => {
    abilityService = {
      getActingUserId: jest.fn().mockReturnValue('owner-1'),
      assertCurrentActorCan: jest.fn(),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
    };
    creation = {
      invite: partyView(),
      event: { eventName: 'invite.created' } as never,
      expired: [{ eventName: 'invite.expired' } as never],
    };
    invites = {
      createWithin: jest.fn().mockImplementation(() => Promise.resolve(creation)),
      emit: jest.fn(),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdInviteService,
        // The real composer over the mocked ability service, as in
        // `household.service.spec.ts`, so the where-clause assertions test the
        // merge the list depends on.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: InviteService, useValue: invites },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdInviteService);

    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
    db.householdMember.findMany.mockResolvedValue(resolves(ROSTER));
    db.role.findUnique.mockImplementation(((args: { where: { name: string } }) =>
      Promise.resolve({ id: `role-${args.where.name}` })) as never);
    db.household.count.mockResolvedValue(1);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createInvite', () => {
    const byId = (overrides: Partial<CreateHouseholdInviteDto> = {}): CreateHouseholdInviteDto => ({
      inviteeId: 'user-2',
      ...overrides,
    });
    const byAddress = (overrides: Partial<CreateHouseholdInviteDto> = {}): CreateHouseholdInviteDto => ({
      inviteeEmail: 'Sam@Example.test',
      ...overrides,
    });

    const userById = (profile: { displayName: string | null } | null = { displayName: 'Sam Doe' }) =>
      db.user.findUnique.mockResolvedValue(resolves({ id: 'user-2', username: 'sam', profile }));

    const inviterAddress = (email: string) => db.user.findUnique.mockResolvedValue(resolves({ email }));

    const createdWith = () => invites.createWithin.mock.calls[0]?.[1];

    it.each([
      ['neither field', {}],
      ['both fields', { inviteeId: 'user-2', inviteeEmail: 'sam@example.test' }],
      // `@IsOptional` lets a JSON null through, and it names nobody.
      ['a null address alone', { inviteeEmail: null }],
      ['a null id alone', { inviteeId: null }],
    ])('refuses %s with 400 before touching the database', async (_label, dto) => {
      await expect(service.createInvite('hh-1', dto as CreateHouseholdInviteDto)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('reads a null beside an id as no address', async () => {
      userById();

      await service.createInvite('hh-1', {
        inviteeId: 'user-2',
        inviteeEmail: null,
      } as unknown as CreateHouseholdInviteDto);

      expect(createdWith()).toMatchObject({ inviteeId: 'user-2', inviteeEmail: null });
    });

    it('asks about an invite into the household before the lock, and again of the roster read under it', async () => {
      userById();
      // Logged by hand: the database double's mocks do not share the call
      // counter the other doubles use, so `invocationCallOrder` cannot order
      // them against each other.
      const steps: string[] = [];
      db.$queryRaw.mockImplementation((() => {
        steps.push('lock');
        return Promise.resolve([{ id: 'hh-1' }]);
      }) as never);
      db.householdMember.findMany.mockImplementation((() => {
        steps.push('roster');
        return Promise.resolve(ROSTER);
      }) as never);
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        steps.push('check');
      });
      invites.createWithin.mockImplementation(() => {
        steps.push('insert');
        return Promise.resolve(creation);
      });

      await service.createInvite('hh-1', byId());

      expect(steps).toEqual(['roster', 'check', 'lock', 'roster', 'check', 'insert']);
      expect(db.householdMember.findMany).toHaveBeenCalledWith({
        where: { householdId: 'hh-1' },
        select: { userId: true, role: { select: { role: { select: { name: true } } } } },
      });
      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
        [Action.create, ResourceType.Invite, { householdId: 'hh-1', household: { members: ROSTER } }],
        [Action.create, ResourceType.Invite, { householdId: 'hh-1', household: { members: ROSTER } }],
      ]);
    });

    it('answers 404 for a missing or deleted household, and writes nothing', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(NotFoundException);

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledTimes(1);
      expect(invites.createWithin).not.toHaveBeenCalled();
    });

    it('refuses a caller with no say here with 403 before taking the lock, and writes nothing', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(invites.createWithin).not.toHaveBeenCalled();
      expect(invites.emit).not.toHaveBeenCalled();
    });

    it('decides from the roster read under the lock, where a demotion that landed first is seen', async () => {
      const demoted = [rosterRow('owner-1', SystemRole.HouseholdMember)];
      db.householdMember.findMany.mockResolvedValueOnce(resolves(ROSTER)).mockResolvedValueOnce(resolves(demoted));
      abilityService.assertCurrentActorCan.mockImplementation((_action, _type, instance) => {
        if ((instance as { household: { members: RosterRow[] } }).household.members === demoted) {
          throw new ForbiddenException();
        }
      });

      await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(invites.createWithin).not.toHaveBeenCalled();
    });

    describe('by id', () => {
      it('opens a household invite as a member by default, with the role resolved to its row', async () => {
        userById();

        await expect(service.createInvite('hh-1', byId({ message: 'Join us' }))).resolves.toBe(creation.invite);

        expect(db.user.findUnique).toHaveBeenCalledWith({
          where: { id: 'user-2', ...PERSON },
          select: { id: true, username: true, profile: { select: { displayName: true } } },
        });

        expect(db.role.findUnique).toHaveBeenCalledWith({
          where: { name: SystemRole.HouseholdMember },
          select: { id: true },
        });
        expect(invites.createWithin).toHaveBeenCalledWith(db, {
          type: InviteType.Household,
          inviterId: 'owner-1',
          householdId: 'hh-1',
          inviteeId: 'user-2',
          inviteeEmail: null,
          inviteeName: 'Sam Doe',
          roleId: `role-${SystemRole.HouseholdMember}`,
          message: 'Join us',
        });
      });

      it('offers the role asked for', async () => {
        userById();

        await service.createInvite('hh-1', byId({ role: SystemRole.HouseholdAdmin }));

        expect(createdWith()?.roleId).toBe(`role-${SystemRole.HouseholdAdmin}`);
      });

      it("names the invitee by the account's display name, then its username, unless a name was given", async () => {
        userById({ displayName: 'Sam Doe' });
        await service.createInvite('hh-1', byId());
        expect(createdWith()?.inviteeName).toBe('Sam Doe');

        invites.createWithin.mockClear();
        userById(null);
        await service.createInvite('hh-1', byId());
        expect(createdWith()?.inviteeName).toBe('sam');

        // Provisioning trims a first name of spaces down to an empty one.
        invites.createWithin.mockClear();
        userById({ displayName: '' });
        await service.createInvite('hh-1', byId());
        expect(createdWith()?.inviteeName).toBe('sam');

        invites.createWithin.mockClear();
        userById();
        await service.createInvite('hh-1', byId({ inviteeName: 'Sammy' }));
        expect(createdWith()?.inviteeName).toBe('Sammy');
      });

      it('answers 404 for an id no user has', async () => {
        db.user.findUnique.mockResolvedValue(null);

        await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(NotFoundException);

        expect(invites.createWithin).not.toHaveBeenCalled();
      });

      it('refuses a current member with 409', async () => {
        db.user.findUnique.mockResolvedValue(resolves({ id: 'member-1', username: 'm', profile: null }));

        await expect(service.createInvite('hh-1', byId({ inviteeId: 'member-1' }))).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(invites.createWithin).not.toHaveBeenCalled();
      });

      it('refuses the inviter as a self-invite, not as a member', async () => {
        db.user.findUnique.mockResolvedValue(resolves({ id: 'owner-1', username: 'owner', profile: null }));

        await expect(service.createInvite('hh-1', byId({ inviteeId: 'owner-1' }))).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });

      it('fails loud when the seed lacks the role', async () => {
        userById();
        db.role.findUnique.mockResolvedValue(null);

        await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(InternalServerErrorException);
      });
    });

    describe('by address', () => {
      it('stores the address alone with the name as typed, and looks no account up', async () => {
        inviterAddress('owner@example.test');

        await service.createInvite('hh-1', byAddress({ inviteeName: 'Sam' }));

        // The one read is the inviter's own address. Nothing asks who holds
        // the invitee's, so no answer can depend on it.
        expect(db.user.findUnique.mock.calls).toEqual([[{ where: { id: 'owner-1' }, select: { email: true } }]]);
        expect(createdWith()).toMatchObject({
          inviteeId: null,
          inviteeEmail: 'Sam@Example.test',
          inviteeName: 'Sam',
        });
      });

      it('stores no name when none was typed', async () => {
        inviterAddress('owner@example.test');

        await service.createInvite('hh-1', byAddress());

        expect(createdWith()?.inviteeName).toBeNull();
      });

      it("refuses the inviter's own address, whatever its case", async () => {
        inviterAddress('sam@example.test');

        await expect(service.createInvite('hh-1', byAddress())).rejects.toBeInstanceOf(BadRequestException);

        expect(invites.createWithin).not.toHaveBeenCalled();
      });
    });

    it('announces any expired rivals and then the created invite, after the transaction', async () => {
      userById();
      let emittedInside: boolean | undefined;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        emittedInside = invites.emit.mock.calls.length > 0;

        return result;
      }) as never);

      await service.createInvite('hh-1', byId());

      expect(emittedInside).toBe(false);
      // The rivals were stamped before the insert, so a listener tracking the
      // outstanding invite never sees two at once.
      expect(invites.emit).toHaveBeenCalledWith([...creation.expired, creation.event]);
    });

    it('announces nothing when the insert fails', async () => {
      userById();
      invites.createWithin.mockRejectedValue(new ConflictException());

      await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ConflictException);

      expect(invites.emit).not.toHaveBeenCalled();
    });
  });

  describe('listInvites', () => {
    const query = (overrides: Partial<ListHouseholdInvitesQueryDto> = {}) =>
      Object.assign(paginationQuery({ limit: 10 }), overrides) as ListHouseholdInvitesQueryDto;

    const listedWhere = () => (db.invite.findMany.mock.calls[0]?.[0] as { where: Prisma.InviteWhereInput }).where;

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
      db.invite.findMany.mockResolvedValue(resolves([]));
      db.invite.count.mockResolvedValue(0);
    });

    afterEach(() => jest.useRealTimers());

    it('answers 404 for a missing household only to a caller who may read its invites', async () => {
      db.household.count.mockResolvedValue(0);

      await expect(service.listInvites('hh-1', query())).rejects.toBeInstanceOf(NotFoundException);

      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });
      db.household.count.mockClear();

      await expect(service.listInvites('hh-1', query())).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.household.count).not.toHaveBeenCalled();
    });

    it('asks about reading THIS household’s invites, and refuses before reading any', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.listInvites('hh-1', query())).rejects.toBeInstanceOf(ForbiddenException);

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.read, ResourceType.Invite, {
        householdId: 'hh-1',
        household: { members: ROSTER },
      });
      expect(db.invite.findMany).not.toHaveBeenCalled();
    });

    it('lists the open invites by default, under the caller’s read ceiling, newest first in one snapshot', async () => {
      await service.listInvites('hh-1', query());

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Invite, Action.read);
      expect(db.invite.findMany).toHaveBeenCalledWith({
        where: {
          householdId: 'hh-1',
          AND: [
            { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] }, expiresAt: { gt: NOW } },
            COND,
          ],
        },
        select: CONTEXT_INVITE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 10,
      });
      expect(db.invite.count).toHaveBeenCalledWith({ where: listedWhere() });
      expect(batchTransactionCall(db).options).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    });

    it.each([
      [
        InviteStatus.Expired,
        {
          OR: [
            { status: InviteStatus.Expired },
            { status: { in: [InviteStatus.AwaitingApproval, InviteStatus.Pending] }, expiresAt: { lte: NOW } },
          ],
        },
      ],
      [InviteStatus.Pending, { status: InviteStatus.Pending, expiresAt: { gt: NOW } }],
      [InviteStatus.AwaitingApproval, { status: InviteStatus.AwaitingApproval, expiresAt: { gt: NOW } }],
      [InviteStatus.Declined, { status: InviteStatus.Declined }],
    ])('filters ?status=%s by the status an invite has now', async (status, filter) => {
      await service.listInvites('hh-1', query({ status }));

      expect(listedWhere()).toEqual({ householdId: 'hh-1', AND: [filter, COND] });
    });

    it('reads the address and message for the rows the caller sent, and for no others', async () => {
      const sent = contextView({ id: 'sent' });
      const others = contextView({ id: 'others', inviter: { id: 'admin-1', username: 'admin', profile: null } });
      db.invite.findMany
        .mockResolvedValueOnce(resolves([sent, others]))
        .mockResolvedValueOnce(resolves([{ id: 'sent', inviteeEmail: 'sam@example.test', message: 'Join us' }]));
      db.invite.count.mockResolvedValue(2);

      const { rows, total } = await service.listInvites('hh-1', query());

      expect(db.invite.findMany).toHaveBeenLastCalledWith({
        where: { id: { in: ['sent'] }, inviterId: 'owner-1' },
        select: { id: true, inviteeEmail: true, message: true },
      });
      expect(total).toBe(2);
      expect(rows[0]).toEqual(partyView({ id: 'sent' }));
      expect(rows[1]).toEqual(others);
    });

    it('reads no party columns when the caller sent none of the rows', async () => {
      db.invite.findMany.mockResolvedValue(
        resolves([contextView({ inviter: { id: 'admin-1', username: 'admin', profile: null } })]),
      );

      await service.listInvites('hh-1', query());

      expect(db.invite.findMany).toHaveBeenCalledTimes(1);
    });

    it('gives an actor with no user the context shape on every row', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });
      db.invite.findMany.mockResolvedValue(resolves([contextView()]));

      const { rows } = await service.listInvites('hh-1', query());

      expect(rows[0]).toEqual(contextView());
      expect(db.invite.findMany).toHaveBeenCalledTimes(1);
    });

    it('reports an outstanding row past its expiry as Expired', async () => {
      db.invite.findMany.mockResolvedValue(
        resolves([contextView({ expiresAt: EARLIER, inviter: { id: 'admin-1', username: 'a', profile: null } })]),
      );

      const { rows } = await service.listInvites('hh-1', query({ status: InviteStatus.Expired }));

      expect(rows[0]?.status).toBe(InviteStatus.Expired);
    });
  });
});
