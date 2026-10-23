import {
  Action,
  friendOfFriendOf,
  FriendshipStatus,
  InviteStatus,
  InviteType,
  MemberInvitePolicy,
  Prisma,
  QuotaScope,
  Reach,
  ResourceType,
  SystemRole,
} from '@bge/database';
import {
  CONTEXT_INVITE_SELECT,
  InviteService,
  type InviteApproval,
  type InviteContextView,
  type InviteCreation,
  type InvitePartyView,
  type InviteRevocation,
} from '@bge/invites';
import { AbilityService, ScopeComposer, type UserAbilityCheck } from '@bge/permissions';
import { QuotaExceededException, QuotaService, type QuotaCheckResult, type QuotaSoftOverageEvent } from '@bge/quota';
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

const SETTINGS = { memberInvitePolicy: MemberInvitePolicy.NeedsApproval };

/** What a create asks about: an invite into `hh-1` offering the member role, opened directly or for approval. */
const createInstance = (needsApproval: boolean, members: RosterRow[] = ROSTER) => ({
  householdId: 'hh-1',
  needsApproval,
  role: { name: SystemRole.HouseholdMember },
  household: { settings: SETTINGS, members },
});

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

/** The columns of a stored row that a read selects, as Prisma answers it. */
const selected = (row: Readonly<Record<string, unknown>>, select: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));

/** `invite-1`'s party columns as stored, of which a read gets what it selects. */
const STORED_INVITE = { id: 'invite-1', inviteeEmail: 'sam@example.test', message: 'Join us' };

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

describe('HouseholdInviteService', () => {
  let service: HouseholdInviteService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<
      AbilityService,
      | 'getActingUserId'
      | 'assertCurrentActorCan'
      | 'currentActorCan'
      | 'getCurrentResourceConditions'
      | 'userAbilityWithin'
    >
  >;
  let senderCan: jest.Mock<boolean, Parameters<UserAbilityCheck>>;
  let invites: jest.Mocked<Pick<InviteService, 'createWithin' | 'revokeWithin' | 'approveWithin' | 'emit'>>;
  let quotas: jest.Mocked<Pick<QuotaService, 'consume' | 'emitSoftOverages'>>;
  let creation: InviteCreation;
  let revocation: InviteRevocation;
  let approval: InviteApproval;

  beforeEach(async () => {
    senderCan = jest.fn().mockReturnValue(true);
    abilityService = {
      getActingUserId: jest.fn().mockReturnValue('owner-1'),
      assertCurrentActorCan: jest.fn(),
      currentActorCan: jest.fn().mockReturnValue(true),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      userAbilityWithin: jest.fn().mockResolvedValue(senderCan),
    };
    creation = {
      invite: partyView(),
      event: { eventName: 'invite.created' } as never,
      expired: [{ eventName: 'invite.expired' } as never],
    };
    revocation = {
      invite: contextView({
        status: InviteStatus.Revoked,
        inviter: { id: 'admin-2', username: 'admin', profile: null },
      }),
      event: { eventName: 'invite.revoked' } as never,
    };
    approval = {
      invite: contextView({ inviter: { id: 'member-1', username: 'member', profile: null } }),
      event: { eventName: 'invite.approved' } as never,
    };
    invites = {
      createWithin: jest.fn().mockImplementation(() => Promise.resolve(creation)),
      revokeWithin: jest.fn().mockImplementation(() => Promise.resolve(revocation)),
      approveWithin: jest.fn().mockImplementation(() => Promise.resolve(approval)),
      emit: jest.fn(),
    };
    quotas = {
      consume: jest.fn().mockResolvedValue(UNCONSTRAINED),
      emitSoftOverages: jest.fn(),
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
        { provide: QuotaService, useValue: quotas },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdInviteService);

    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([{ id: 'hh-1' }] as never);
    db.householdMember.findMany.mockResolvedValue(resolves(ROSTER));
    db.household.findUnique.mockResolvedValue(resolves({ settings: SETTINGS, members: ROSTER }));
    db.role.findUnique.mockImplementation(((args: { where: { name: string } }) =>
      Promise.resolve({ id: `role-${args.where.name}` })) as never);
    db.household.count.mockResolvedValue(1);
    db.invite.findUniqueOrThrow.mockImplementation(((args: { select: Record<string, unknown> }) =>
      Promise.resolve(selected(STORED_INVITE, args.select))) as never);
    // The role an existing invite offers, read for a revoke or an approval (#168).
    db.invite.findFirst.mockResolvedValue({ role: { name: SystemRole.HouseholdMember } } as never);
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

    /** The inviter's own address, read for the self-invite check; any other lookup finds nobody. */
    const inviterAddress = (email: string) =>
      db.user.findUnique.mockImplementation(((args: { where: { id?: string } }) =>
        Promise.resolve(args.where.id === 'owner-1' ? { email } : null)) as never);

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
      db.household.findUnique.mockImplementation((() => {
        steps.push('household');
        return Promise.resolve({ settings: SETTINGS, members: ROSTER });
      }) as never);
      abilityService.currentActorCan.mockImplementation(() => {
        steps.push('check');
        return true;
      });
      invites.createWithin.mockImplementation(() => {
        steps.push('insert');
        return Promise.resolve(creation);
      });

      await service.createInvite('hh-1', byId());

      // The roster and the policy in one read, each time.
      expect(steps).toEqual(['household', 'check', 'lock', 'household', 'check', 'insert']);
      expect(db.household.findUnique).toHaveBeenCalledWith({
        where: { id: 'hh-1' },
        select: {
          settings: { select: { memberInvitePolicy: true } },
          members: { select: { userId: true, role: { select: { role: { select: { name: true } } } } } },
        },
      });
      expect(abilityService.currentActorCan.mock.calls).toEqual([
        [Action.create, ResourceType.Invite, createInstance(false)],
        [Action.create, ResourceType.Invite, createInstance(false)],
      ]);
    });

    it('answers 404 for a missing or deleted household, and writes nothing', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(NotFoundException);

      expect(abilityService.currentActorCan).toHaveBeenCalledTimes(1);
      expect(invites.createWithin).not.toHaveBeenCalled();
    });

    it('refuses a caller with no say here with 403 before taking the lock, and writes nothing', async () => {
      abilityService.currentActorCan.mockReturnValue(false);
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
      const demoted = [rosterRow('owner-1', SystemRole.HouseholdGuest)];
      const isDemoted = (instance: unknown) =>
        (instance as { household: { members: RosterRow[] } }).household.members === demoted;
      db.household.findUnique
        .mockResolvedValueOnce(resolves({ settings: SETTINGS, members: ROSTER }))
        .mockResolvedValueOnce(resolves({ settings: SETTINGS, members: demoted }));
      abilityService.currentActorCan.mockImplementation((_action, _type, instance) => !isDemoted(instance));
      abilityService.assertCurrentActorCan.mockImplementation((_action, _type, instance) => {
        if (isDemoted(instance)) {
          throw new ForbiddenException();
        }
      });

      await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(invites.createWithin).not.toHaveBeenCalled();
    });

    describe('how the invite opens (#166)', () => {
      beforeEach(() => userById());

      it('opens it directly when the acting user may invite directly, asking nothing more', async () => {
        await service.createInvite('hh-1', byId());

        expect(createdWith()?.needsApproval).toBe(false);
        expect(abilityService.assertCurrentActorCan).not.toHaveBeenCalled();
      });

      it('opens it awaiting approval when the acting user may only invite for approval', async () => {
        abilityService.currentActorCan.mockReturnValue(false);

        await service.createInvite('hh-1', byId());

        expect(createdWith()?.needsApproval).toBe(true);
        // Asked about opening it directly first, then for approval, each time.
        expect(abilityService.currentActorCan.mock.calls).toEqual([
          [Action.create, ResourceType.Invite, createInstance(false)],
          [Action.create, ResourceType.Invite, createInstance(false)],
        ]);
        expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
          [Action.create, ResourceType.Invite, createInstance(true)],
          [Action.create, ResourceType.Invite, createInstance(true)],
        ]);
      });

      it('decides from the answer under the lock, where a policy change that landed first is seen', async () => {
        abilityService.currentActorCan.mockReturnValueOnce(true).mockReturnValueOnce(false);

        await service.createInvite('hh-1', byId());

        expect(createdWith()?.needsApproval).toBe(true);
      });

      it('asks about the role the invite offers', async () => {
        abilityService.currentActorCan.mockReturnValue(false);

        await service.createInvite('hh-1', byId({ role: SystemRole.HouseholdGuest }));

        expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.Invite, {
          ...createInstance(true),
          role: { name: SystemRole.HouseholdGuest },
        });
      });

      it('asks with no settings when the household has no settings row, which no member permission matches', async () => {
        db.household.findUnique.mockResolvedValue(resolves({ settings: null, members: ROSTER }));

        await service.createInvite('hh-1', byId());

        expect(abilityService.currentActorCan).toHaveBeenCalledWith(Action.create, ResourceType.Invite, {
          ...createInstance(false),
          household: { settings: null, members: ROSTER },
        });
      });
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
          withheld: false,
          needsApproval: false,
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
      it('stores the address alone with the name as typed, binding no account', async () => {
        inviterAddress('owner@example.test');

        await service.createInvite('hh-1', byAddress({ inviteeName: 'Sam' }));

        // The accept (#163) binds whoever answers the invite.
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

    describe('who may be invited (#278)', () => {
      const serverPolicy = (householdInviteePolicy: Reach) =>
        db.systemSetting.findUnique.mockResolvedValue(resolves({ householdInviteePolicy }));

      /** Whether a user filter names the invitee: `user-2` by id, or as the holder of `sam@example.test`. */
      const namesInvitee = (filter: unknown) => {
        const { id, email } = filter as { id?: string; email?: string };

        return id === 'user-2' || email === 'sam@example.test';
      };

      /** The invitee's friendship with the inviter has this status, or there is none. */
      const friendship = (status: FriendshipStatus | null) =>
        db.friendship.findFirst.mockImplementation(((args: {
          where: { OR: [{ addressee: unknown }, { requester: unknown }] };
        }) =>
          Promise.resolve(
            status !== null && namesInvitee(args.where.OR[0].addressee) && namesInvitee(args.where.OR[1].requester)
              ? { status }
              : null,
          )) as never);

      /** The invitee's preference row says this. */
      const preference = (allowHouseholdInvitesFrom: Reach) =>
        db.userPreferences.findFirst.mockImplementation(((args: { where: { user: unknown } }) =>
          Promise.resolve(namesInvitee(args.where.user) ? { allowHouseholdInvitesFrom } : null)) as never);

      /** Whether the invitee is a friend of a friend of the inviter, as the gate counts it (#496). */
      const friendOfFriend = (yes: boolean) =>
        db.user.count.mockImplementation(((args: { where: { AND: [unknown, unknown] } }) =>
          Promise.resolve(yes && namesInvitee(args.where.AND[0]) ? 1 : 0)) as never);

      describe('the server policy', () => {
        it('refuses a non-friend by id under Friends with 403, and writes nothing', async () => {
          serverPolicy(Reach.Friends);
          friendship(null);
          userById();

          await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ForbiddenException);

          expect(invites.createWithin).not.toHaveBeenCalled();
        });

        it.each([FriendshipStatus.Pending, FriendshipStatus.Declined, FriendshipStatus.Withdrawn])(
          'counts a %s friendship as no friendship under Friends',
          async (status) => {
            serverPolicy(Reach.Friends);
            friendship(status);
            userById();

            await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ForbiddenException);
          },
        );

        it('lets a friend be invited by id under Friends', async () => {
          serverPolicy(Reach.Friends);
          friendship(FriendshipStatus.Accepted);
          userById();

          await service.createInvite('hh-1', byId());

          expect(createdWith()).toMatchObject({ inviteeId: 'user-2', withheld: false });
        });

        // A friend's address passing where any other failed would let the
        // inviter test which addresses belong to their friends, and under
        // FriendsOfFriends to their friends of friends (#496).
        it.each([Reach.Friends, Reach.FriendsOfFriends])(
          'refuses every invite by address under %s, before reading anything about it',
          async (level) => {
            serverPolicy(level);
            inviterAddress('owner@example.test');

            await expect(service.createInvite('hh-1', byAddress())).rejects.toBeInstanceOf(ForbiddenException);

            expect(db.user.findUnique.mock.calls).toEqual([[{ where: { id: 'owner-1' }, select: { email: true } }]]);
            expect(db.friendship.findFirst).not.toHaveBeenCalled();
            expect(db.userPreferences.findFirst).not.toHaveBeenCalled();
            expect(db.user.count).not.toHaveBeenCalled();
            expect(invites.createWithin).not.toHaveBeenCalled();
          },
        );

        it('lets a friend of a friend be invited by id under FriendsOfFriends', async () => {
          serverPolicy(Reach.FriendsOfFriends);
          friendship(null);
          friendOfFriend(true);
          userById();

          await service.createInvite('hh-1', byId());

          expect(createdWith()).toMatchObject({ inviteeId: 'user-2', withheld: false });
          // The same definition the read rules use, bound to the inviter.
          expect(db.user.count).toHaveBeenCalledWith({
            where: { AND: [{ id: 'user-2' }, friendOfFriendOf('owner-1')] },
          });
        });

        // Told "only your friends", a refused inviter would be told wrong under
        // FriendsOfFriends, which lets in their friends of friends too (#496).
        it.each([
          [Reach.Friends, 'errors.household.invitee_friends_only'],
          [Reach.FriendsOfFriends, 'errors.household.invitee_friends_of_friends_only'],
        ])('refuses under %s, by id and by address, in words that say who it lets in', async (level, key) => {
          serverPolicy(level);
          friendship(null);
          friendOfFriend(false);
          const refusalOf = (dto: CreateHouseholdInviteDto) =>
            service.createInvite('hh-1', dto).catch((reason: unknown) => reason);

          userById();
          const byIdError = await refusalOf(byId());
          inviterAddress('owner@example.test');
          const byAddressError = await refusalOf(byAddress());

          for (const error of [byIdError, byAddressError]) {
            expect(error).toBeInstanceOf(ForbiddenException);
            expect((error as ForbiddenException).message).toContain(key);
          }
        });

        it('refuses someone no friend links by id under FriendsOfFriends, and writes nothing', async () => {
          serverPolicy(Reach.FriendsOfFriends);
          friendship(null);
          friendOfFriend(false);
          userById();

          await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ForbiddenException);

          expect(invites.createWithin).not.toHaveBeenCalled();
        });

        it('lets a direct friend in under FriendsOfFriends without asking about friends of friends', async () => {
          serverPolicy(Reach.FriendsOfFriends);
          friendship(FriendshipStatus.Accepted);
          preference(Reach.Public);
          userById();

          await service.createInvite('hh-1', byId());

          expect(invites.createWithin).toHaveBeenCalledTimes(1);
          expect(db.user.count).not.toHaveBeenCalled();
        });

        // A friend they share links them, but the block between them stands
        // (#496). A blocked pair is no friends of friends, so the policy refuses
        // them in its own words, as `Friends` refuses a blocked pair. Both of
        // the pair already see the block among their friendships.
        it('refuses a blocked pair under FriendsOfFriends, whatever friends they share, in the policy’s words', async () => {
          serverPolicy(Reach.FriendsOfFriends);
          friendship(FriendshipStatus.Blocked);
          friendOfFriend(true);
          userById();

          const error = await service.createInvite('hh-1', byId()).catch((reason: unknown) => reason);

          expect(error).toBeInstanceOf(ForbiddenException);
          expect((error as ForbiddenException).message).toContain('errors.household.invitee_friends_of_friends_only');
          expect(invites.createWithin).not.toHaveBeenCalled();
        });

        it('lets anyone be invited under Public, by id or by address', async () => {
          serverPolicy(Reach.Public);
          friendship(null);
          userById();

          await service.createInvite('hh-1', byId());

          inviterAddress('owner@example.test');
          await service.createInvite('hh-1', byAddress());

          expect(invites.createWithin).toHaveBeenCalledTimes(2);
        });

        it('reads no settings row as Public', async () => {
          db.systemSetting.findUnique.mockResolvedValue(null);
          friendship(null);
          userById();

          await service.createInvite('hh-1', byId());

          expect(invites.createWithin).toHaveBeenCalledTimes(1);
        });

        // Private lets nobody in, should a write that skips the PATCH store it.
        it.each([Reach.Private])('fails closed on %s, a level the PATCH refuses', async (level) => {
          serverPolicy(level);
          friendship(null);
          userById();

          await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ForbiddenException);

          inviterAddress('owner@example.test');
          await expect(service.createInvite('hh-1', byAddress())).rejects.toBeInstanceOf(ForbiddenException);
        });
      });

      describe('by id, a block and the invitee’s preference', () => {
        /** The error `createInvite` rejects with. */
        const refusal = async (dto: CreateHouseholdInviteDto) => {
          const error = await service.createInvite('hh-1', dto).then(
            () => undefined,
            (reason: unknown) => reason,
          );
          expect(error).toBeInstanceOf(ForbiddenException);

          return (error as ForbiddenException).message;
        };

        beforeEach(() => {
          serverPolicy(Reach.Public);
          userById();
        });

        it('refuses a blocked pair with 403 even under Public, and writes nothing', async () => {
          friendship(FriendshipStatus.Blocked);

          await refusal(byId());

          expect(invites.createWithin).not.toHaveBeenCalled();
        });

        it('honours a preference stricter than the server’s', async () => {
          friendship(null);
          preference(Reach.Friends);
          await refusal(byId());

          friendship(FriendshipStatus.Accepted);
          preference(Reach.Private);
          await refusal(byId());

          expect(invites.createWithin).not.toHaveBeenCalled();
        });

        it('lets a friend through a Friends preference, and anyone through no preference row', async () => {
          friendship(FriendshipStatus.Accepted);
          preference(Reach.Friends);
          await service.createInvite('hh-1', byId());

          friendship(null);
          db.userPreferences.findFirst.mockResolvedValue(null);
          await service.createInvite('hh-1', byId());

          expect(invites.createWithin).toHaveBeenCalledTimes(2);
        });

        it('honours a FriendsOfFriends preference: by id it admits a friend of a friend and refuses anyone else', async () => {
          friendship(null);
          preference(Reach.FriendsOfFriends);

          friendOfFriend(true);
          await service.createInvite('hh-1', byId());
          expect(invites.createWithin).toHaveBeenCalledTimes(1);

          friendOfFriend(false);
          await refusal(byId());
          expect(invites.createWithin).toHaveBeenCalledTimes(1);
        });

        it('asks about friends of friends by id only when a level names them', async () => {
          friendship(null);
          preference(Reach.Public);

          await service.createInvite('hh-1', byId());

          expect(db.user.count).not.toHaveBeenCalled();
        });

        it('asks about friends of friends by id once, when both the policy and the preference name them', async () => {
          serverPolicy(Reach.FriendsOfFriends);
          friendship(null);
          preference(Reach.FriendsOfFriends);
          friendOfFriend(true);

          await service.createInvite('hh-1', byId());

          expect(invites.createWithin).toHaveBeenCalledTimes(1);
          expect(db.user.count).toHaveBeenCalledTimes(1);
        });

        it('answers a block and a preference alike, so the inviter cannot tell which applied', async () => {
          friendship(FriendshipStatus.Blocked);
          const blocked = await refusal(byId());

          friendship(null);
          preference(Reach.Private);
          const declined = await refusal(byId());

          expect(blocked).toBe(declined);
        });

        it('does not let a looser preference widen the server’s policy, which refuses in its own words', async () => {
          friendship(FriendshipStatus.Blocked);
          const blocked = await refusal(byId());

          serverPolicy(Reach.Friends);
          friendship(null);
          preference(Reach.Public);
          const byPolicy = await refusal(byId());

          expect(byPolicy).not.toBe(blocked);
        });
      });

      describe('by address, a block and the invitee’s preference', () => {
        beforeEach(() => {
          serverPolicy(Reach.Public);
          inviterAddress('owner@example.test');
        });

        it('finds the holder of an address typed in any case or with spaces', async () => {
          friendship(FriendshipStatus.Blocked);

          await service.createInvite('hh-1', byAddress({ inviteeEmail: '  Sam@Example.TEST ' }));

          expect(createdWith()?.withheld).toBe(true);
        });

        it.each([
          ['a block between the pair', () => friendship(FriendshipStatus.Blocked)],
          ['a Friends preference, to a non-friend', () => preference(Reach.Friends)],
          ['a Private preference', () => preference(Reach.Private)],
          [
            'a FriendsOfFriends preference, to someone no friend links',
            () => {
              preference(Reach.FriendsOfFriends);
              friendOfFriend(false);
            },
          ],
        ])('stores the invite withheld for %s, and answers as it answers any other', async (_label, arrange) => {
          arrange();

          await expect(service.createInvite('hh-1', byAddress())).resolves.toBe(creation.invite);

          expect(createdWith()).toMatchObject({ inviteeId: null, inviteeEmail: 'Sam@Example.test', withheld: true });
          expect(invites.emit).toHaveBeenCalledWith([...creation.expired, creation.event]);
        });

        it('withholds nothing when no account holds the address, or its holder lets the inviter in', async () => {
          friendship(FriendshipStatus.Blocked);
          preference(Reach.Private);
          await service.createInvite('hh-1', byAddress({ inviteeEmail: 'nobody@example.test' }));

          friendship(FriendshipStatus.Accepted);
          preference(Reach.Friends);
          await service.createInvite('hh-1', byAddress());

          friendship(null);
          preference(Reach.FriendsOfFriends);
          friendOfFriend(true);
          await service.createInvite('hh-1', byAddress());

          expect(invites.createWithin.mock.calls.map(([, params]) => params.withheld)).toEqual([false, false, false]);
        });

        // How long the create takes must say no more than its answer does.
        it.each([
          ['no account holds the address', 'nobody@example.test', () => undefined],
          ['its holder lets the inviter in', 'sam@example.test', () => undefined],
          ['its holder blocks the inviter', 'sam@example.test', () => friendship(FriendshipStatus.Blocked)],
          ['its holder admits friends of friends only', 'sam@example.test', () => preference(Reach.FriendsOfFriends)],
        ])('makes the same reads when %s', async (_label, inviteeEmail, arrange) => {
          arrange();

          await service.createInvite('hh-1', byAddress({ inviteeEmail }));

          // The one account read is the inviter's own, for the self-invite check.
          expect(db.user.findUnique).toHaveBeenCalledTimes(1);
          expect(db.friendship.findFirst).toHaveBeenCalledTimes(1);
          expect(db.userPreferences.findFirst).toHaveBeenCalledTimes(1);
          // Asked whatever the preference, so a FriendsOfFriends one costs no
          // read the others don't (#496).
          expect(db.user.count).toHaveBeenCalledTimes(1);
        });
      });
    });

    describe('how many invites a day (#279)', () => {
      const overage: QuotaSoftOverageEvent = {
        scope: QuotaScope.User,
        scopeId: 'owner-1',
        resource: 'household_invite_daily_count',
        currentUsage: '5',
        attemptedAmount: '1',
        limit: '5',
      };

      beforeEach(() => {
        userById();
      });

      it("takes one of the inviter's and the household's daily invites, on the transaction, before the insert", async () => {
        const steps: string[] = [];
        quotas.consume.mockImplementation(() => {
          steps.push('cap');

          return Promise.resolve(UNCONSTRAINED);
        });
        invites.createWithin.mockImplementation(() => {
          steps.push('insert');

          return Promise.resolve(creation);
        });

        await service.createInvite('hh-1', byId());

        expect(quotas.consume).toHaveBeenCalledWith(
          'household_invite_daily_count',
          1n,
          { userId: 'owner-1', householdId: 'hh-1' },
          db,
        );
        expect(steps).toEqual(['cap', 'insert']);
      });

      it("takes only the inviter's for an invite that waits for approval, leaving the household's to the approval", async () => {
        abilityService.currentActorCan.mockReturnValue(false);

        await service.createInvite('hh-1', byId());

        expect(createdWith()?.needsApproval).toBe(true);
        expect(quotas.consume).toHaveBeenCalledWith('household_invite_daily_count', 1n, { userId: 'owner-1' }, db);
      });

      it('takes a slot for an invite by address as well', async () => {
        inviterAddress('owner@example.test');

        await service.createInvite('hh-1', byAddress());

        expect(quotas.consume).toHaveBeenCalledWith(
          'household_invite_daily_count',
          1n,
          { userId: 'owner-1', householdId: 'hh-1' },
          db,
        );
      });

      it('refuses with 402 past the cap, naming the binding scope, and writes and announces nothing', async () => {
        quotas.consume.mockResolvedValue({
          ...UNCONSTRAINED,
          allowed: false,
          scope: QuotaScope.Household,
          currentUsage: 20n,
          limit: 20n,
        });

        const error = await service.createInvite('hh-1', byId()).then(
          () => undefined,
          (reason: unknown) => reason,
        );

        expect(error).toBeInstanceOf(QuotaExceededException);
        expect((error as QuotaExceededException).getStatus()).toBe(402);
        expect((error as QuotaExceededException).getResponse()).toMatchObject({
          resource: 'household_invite_daily_count',
          scope: QuotaScope.Household,
          limit: '20',
          currentUsage: '20',
          attemptedAmount: '1',
        });
        expect(invites.createWithin).not.toHaveBeenCalled();
        expect(invites.emit).not.toHaveBeenCalled();
        expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
      });

      it('takes no slot for an invite the gate refuses, so it never waits on the cap', async () => {
        db.systemSetting.findUnique.mockResolvedValue(resolves({ householdInviteePolicy: Reach.Friends }));

        await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ForbiddenException);

        expect(quotas.consume).not.toHaveBeenCalled();
      });

      it("warns of a soft cap after the transaction, after the invite's own events", async () => {
        quotas.consume.mockResolvedValue({ ...UNCONSTRAINED, softOverages: [overage] });
        let warnedInside: boolean | undefined;
        db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
          const result = await work(db);
          warnedInside = quotas.emitSoftOverages.mock.calls.length > 0;

          return result;
        }) as never);

        await service.createInvite('hh-1', byId());

        expect(warnedInside).toBe(false);
        expect(quotas.emitSoftOverages).toHaveBeenCalledWith([overage]);
        expect(invites.emit.mock.invocationCallOrder[0]).toBeLessThan(
          quotas.emitSoftOverages.mock.invocationCallOrder[0] as number,
        );
      });

      it('warns of nothing when the insert fails', async () => {
        quotas.consume.mockResolvedValue({ ...UNCONSTRAINED, softOverages: [overage] });
        invites.createWithin.mockRejectedValue(new ConflictException());

        await expect(service.createInvite('hh-1', byId())).rejects.toBeInstanceOf(ConflictException);

        expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
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

  describe('revokeInvite', () => {
    it('asks about revoking an invite of the household before the lock, and again of the roster read under it', async () => {
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
      db.invite.findFirst.mockImplementation((() => {
        steps.push('offered role');
        return Promise.resolve({ role: { name: SystemRole.HouseholdMember } });
      }) as never);
      invites.revokeWithin.mockImplementation(() => {
        steps.push('revoke');
        return Promise.resolve(revocation);
      });

      await expect(service.revokeInvite('hh-1', 'invite-1')).resolves.toMatchObject(revocation.invite);

      // The household row, then the invite: the order a soft delete takes them in.
      // The role the invite offers is set when it is sent, so it is read once,
      // before the lock, and both questions ask of it.
      expect(steps).toEqual(['offered role', 'roster', 'check', 'lock', 'roster', 'check', 'revoke']);
      // Named by its id, so a key scoped to this one invite is asked about it,
      // and asked about `status`, the column a revoke changes, so the approve
      // permission does not pass for it.
      const instance = {
        id: 'invite-1',
        householdId: 'hh-1',
        role: { name: SystemRole.HouseholdMember },
        household: { members: ROSTER },
      };
      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
        [Action.update, ResourceType.Invite, instance, 'status'],
        [Action.update, ResourceType.Invite, instance, 'status'],
      ]);
      // The revoker is named so the lib refuses an inviter revoking their own invite.
      expect(invites.revokeWithin).toHaveBeenCalledWith(db, {
        inviteId: 'invite-1',
        revokerId: 'owner-1',
        scope: { householdId: 'hh-1' },
      });
    });

    it('refuses a caller with no say here with 403 before taking the lock, and revokes nothing', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.revokeInvite('hh-1', 'invite-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(invites.revokeWithin).not.toHaveBeenCalled();
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

      await expect(service.revokeInvite('hh-1', 'invite-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(invites.revokeWithin).not.toHaveBeenCalled();
    });

    it('answers 404 for a missing or deleted household, and revokes nothing', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.revokeInvite('hh-1', 'invite-1')).rejects.toBeInstanceOf(NotFoundException);

      expect(invites.revokeWithin).not.toHaveBeenCalled();
    });

    describe('the role the invite offers (#168)', () => {
      // An admin revokes only an invite offering the member or guest role, so
      // the instance carries the role this household's invite offers.
      const askedAbout = () =>
        abilityService.assertCurrentActorCan.mock.calls.map(([, , instance]) => (instance as { role?: unknown }).role);

      it('puts the role the invite offers on the instance, read of this household', async () => {
        db.invite.findFirst.mockResolvedValue({ role: { name: SystemRole.HouseholdAdmin } } as never);

        await service.revokeInvite('hh-1', 'invite-1');

        expect(db.invite.findFirst).toHaveBeenCalledWith({
          where: { id: 'invite-1', householdId: 'hh-1' },
          select: { role: { select: { name: true } } },
        });
        expect(askedAbout()).toEqual([{ name: SystemRole.HouseholdAdmin }, { name: SystemRole.HouseholdAdmin }]);
      });

      it('asks about an invite this household does not have as one offering the member role, so the lib answers 404', async () => {
        // The question then is whether the actor may revoke any invite here:
        // an owner or admin reaches the lib's 404, and anyone else is refused
        // as before, which says nothing about invites elsewhere.
        db.invite.findFirst.mockResolvedValue(null);
        invites.revokeWithin.mockRejectedValue(new NotFoundException());

        await expect(service.revokeInvite('hh-1', 'invite-9')).rejects.toBeInstanceOf(NotFoundException);

        expect(askedAbout()).toEqual([{ name: SystemRole.HouseholdMember }, { name: SystemRole.HouseholdMember }]);
        expect(invites.revokeWithin).toHaveBeenCalled();
      });

      it('asks about an invite naming no role as offering the member role, which its accept admits with', async () => {
        db.invite.findFirst.mockResolvedValue({ role: null } as never);

        await service.revokeInvite('hh-1', 'invite-1');

        expect(askedAbout()).toEqual([{ name: SystemRole.HouseholdMember }, { name: SystemRole.HouseholdMember }]);
      });
    });

    it('announces the revoke after the transaction', async () => {
      let emittedInside: boolean | undefined;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        emittedInside = invites.emit.mock.calls.length > 0;

        return result;
      }) as never);

      await service.revokeInvite('hh-1', 'invite-1');

      expect(emittedInside).toBe(false);
      expect(invites.emit).toHaveBeenCalledWith([revocation.event]);
    });

    it('announces nothing when the lib refuses', async () => {
      invites.revokeWithin.mockRejectedValue(new ForbiddenException());

      await expect(service.revokeInvite('hh-1', 'invite-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(invites.emit).not.toHaveBeenCalled();
    });
  });

  describe('approveInvite (#166)', () => {
    it('asks about approving an invite of the household before the lock, and again of the roster read under it', async () => {
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
      quotas.consume.mockImplementation(() => {
        steps.push('cap');
        return Promise.resolve(UNCONSTRAINED);
      });
      db.invite.findFirst.mockImplementation((() => {
        steps.push('offered role');
        return Promise.resolve({ role: { name: SystemRole.HouseholdMember } });
      }) as never);
      invites.approveWithin.mockImplementation(() => {
        steps.push('approve');
        return Promise.resolve(approval);
      });

      await expect(service.approveInvite('hh-1', 'invite-1')).resolves.toMatchObject(approval.invite);

      expect(steps).toEqual(['offered role', 'roster', 'check', 'lock', 'roster', 'check', 'cap', 'approve']);
      // Asked about `approvedById`, the column only an approval writes, so the
      // revoke permission does not pass for it.
      const instance = {
        id: 'invite-1',
        householdId: 'hh-1',
        role: { name: SystemRole.HouseholdMember },
        household: { members: ROSTER },
      };
      expect(abilityService.assertCurrentActorCan.mock.calls).toEqual([
        [Action.update, ResourceType.Invite, instance, 'approvedById'],
        [Action.update, ResourceType.Invite, instance, 'approvedById'],
      ]);
      expect(invites.approveWithin).toHaveBeenCalledWith(db, {
        inviteId: 'invite-1',
        approverId: 'owner-1',
        scope: { householdId: 'hh-1' },
        expiresAt: expect.any(Date),
      });
    });

    it('gives the invitee a full week from the approval, whatever time the wait for it took', async () => {
      const week = 7 * 24 * 60 * 60 * 1_000;
      const before = Date.now();

      await service.approveInvite('hh-1', 'invite-1');

      const [[, params]] = invites.approveWithin.mock.calls;
      const expiresAt = params.expiresAt?.getTime() ?? Number.NaN;
      expect(expiresAt).toBeGreaterThanOrEqual(before + week);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + week);
    });

    describe("the household's invites for the day (#279)", () => {
      it("takes one of the household's, and none of the approver's or the inviter's", async () => {
        await service.approveInvite('hh-1', 'invite-1');

        expect(quotas.consume).toHaveBeenCalledWith('household_invite_daily_count', 1n, { householdId: 'hh-1' }, db);
      });

      it('refuses with 402 past the cap, and approves and announces nothing', async () => {
        quotas.consume.mockResolvedValue({
          ...UNCONSTRAINED,
          allowed: false,
          scope: QuotaScope.Household,
          currentUsage: 20n,
          limit: 20n,
        });

        const error = await service.approveInvite('hh-1', 'invite-1').then(
          () => undefined,
          (reason: unknown) => reason,
        );

        expect(error).toBeInstanceOf(QuotaExceededException);
        expect((error as QuotaExceededException).getResponse()).toMatchObject({
          resource: 'household_invite_daily_count',
          scope: QuotaScope.Household,
          limit: '20',
          currentUsage: '20',
        });
        expect(invites.approveWithin).not.toHaveBeenCalled();
        expect(invites.emit).not.toHaveBeenCalled();
        expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
      });

      it("warns of a soft cap after the transaction, after the approval's event", async () => {
        const overage: QuotaSoftOverageEvent = {
          scope: QuotaScope.Household,
          scopeId: 'hh-1',
          resource: 'household_invite_daily_count',
          currentUsage: '5',
          attemptedAmount: '1',
          limit: '5',
        };
        quotas.consume.mockResolvedValue({ ...UNCONSTRAINED, softOverages: [overage] });
        let warnedInside: boolean | undefined;
        db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
          const result = await work(db);
          warnedInside = quotas.emitSoftOverages.mock.calls.length > 0;

          return result;
        }) as never);

        await service.approveInvite('hh-1', 'invite-1');

        expect(warnedInside).toBe(false);
        expect(quotas.emitSoftOverages).toHaveBeenCalledWith([overage]);
        expect(invites.emit.mock.invocationCallOrder[0]).toBeLessThan(
          quotas.emitSoftOverages.mock.invocationCallOrder[0] as number,
        );
      });
    });

    it('refuses an actor with no say here with 403 before taking the lock, and approves nothing', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.approveInvite('hh-1', 'invite-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(quotas.consume).not.toHaveBeenCalled();
      expect(invites.approveWithin).not.toHaveBeenCalled();
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

      await expect(service.approveInvite('hh-1', 'invite-1')).rejects.toBeInstanceOf(ForbiddenException);

      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(invites.approveWithin).not.toHaveBeenCalled();
    });

    it('answers 404 for a missing or deleted household, and approves nothing', async () => {
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.approveInvite('hh-1', 'invite-1')).rejects.toBeInstanceOf(NotFoundException);

      expect(invites.approveWithin).not.toHaveBeenCalled();
    });

    it('announces the approval after the transaction, and nothing when the lib refuses', async () => {
      let emittedInside: boolean | undefined;
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        emittedInside = invites.emit.mock.calls.length > 0;

        return result;
      }) as never);

      await service.approveInvite('hh-1', 'invite-1');

      expect(emittedInside).toBe(false);
      expect(invites.emit).toHaveBeenCalledWith([approval.event]);

      invites.emit.mockClear();
      invites.approveWithin.mockRejectedValue(new ConflictException());

      await expect(service.approveInvite('hh-1', 'invite-1')).rejects.toBeInstanceOf(ConflictException);

      expect(invites.emit).not.toHaveBeenCalled();
    });

    describe('whether the sender could still send it (#747)', () => {
      /** The instance the sender's own invite grants are asked about, as the create builds it. */
      const senderInstance = (needsApproval: boolean) => ({
        householdId: 'hh-1',
        needsApproval,
        role: { name: SystemRole.HouseholdMember },
        household: { settings: SETTINGS, members: ROSTER },
      });

      it("asks the sender's own ability, after the lib approves, either way an accept of the approved invite would", async () => {
        senderCan.mockReturnValueOnce(false).mockReturnValueOnce(true);

        await expect(service.approveInvite('hh-1', 'invite-1')).resolves.toMatchObject(approval.invite);

        expect(abilityService.userAbilityWithin).toHaveBeenCalledWith(db, 'member-1');
        expect(senderCan.mock.calls).toEqual([
          [Action.create, ResourceType.Invite, senderInstance(false)],
          [Action.create, ResourceType.Invite, senderInstance(true)],
        ]);
        expect(abilityService.userAbilityWithin.mock.invocationCallOrder[0]).toBeGreaterThan(
          invites.approveWithin.mock.invocationCallOrder[0] as number,
        );
      });

      it('asks about the role the admission grants when the approved invite offers none', async () => {
        approval = { ...approval, invite: { ...approval.invite, role: null } };

        await service.approveInvite('hh-1', 'invite-1');

        expect(senderCan).toHaveBeenCalledWith(Action.create, ResourceType.Invite, senderInstance(false));
      });

      it("refuses with 409 when they could send it neither way, and announces nothing, so the rollback undoes the approval and the day's invite", async () => {
        senderCan.mockReturnValue(false);

        await expect(service.approveInvite('hh-1', 'invite-1')).rejects.toMatchObject({
          status: 409,
          response: expect.objectContaining({ key: 'errors.invite.sender_cannot_send', args: { id: 'invite-1' } }),
        });

        expect(invites.emit).not.toHaveBeenCalled();
        expect(quotas.emitSoftOverages).not.toHaveBeenCalled();
      });
    });
  });

  describe('what a revoke or an approve answers (#167)', () => {
    beforeEach(() => {
      db.householdMember.findMany.mockResolvedValue(
        resolves([...ROSTER, rosterRow('admin-1', SystemRole.HouseholdAdmin)]),
      );
    });

    it('returns the address with an approve or revoke by a household admin (#167)', async () => {
      abilityService.getActingUserId.mockReturnValue('admin-1');
      const steps: string[] = [];
      db.$transaction.mockImplementation((async (work: (tx: MockDatabaseService) => Promise<unknown>) => {
        const result = await work(db);
        steps.push('commit');

        return result;
      }) as never);
      invites.revokeWithin.mockImplementation(() => {
        steps.push('revoke');
        return Promise.resolve(revocation);
      });
      invites.approveWithin.mockImplementation(() => {
        steps.push('approve');
        return Promise.resolve(approval);
      });
      db.invite.findUniqueOrThrow.mockImplementation(((args: { select: Record<string, unknown> }) => {
        steps.push('address');
        return Promise.resolve(selected(STORED_INVITE, args.select));
      }) as never);

      const revoked = await service.revokeInvite('hh-1', 'invite-1');
      const approved = await service.approveInvite('hh-1', 'invite-1');

      // The address, and never the message, which stays with the parties.
      expect(revoked).toEqual({ ...revocation.invite, inviteeEmail: 'sam@example.test' });
      expect(approved).toEqual({ ...approval.invite, inviteeEmail: 'sam@example.test' });
      // Read on the transaction, once the transition has bound the invite to
      // this household, so a refused transition reads none.
      expect(steps).toEqual(['revoke', 'address', 'commit', 'approve', 'address', 'commit']);
    });

    // Staff may hold a grant here, and a member could hold extra permissions
    // through a variant of their role (#844); only the roster's owner and admin
    // roles show the address.
    it.each([
      ['staff, who hold no household role', 'staff-1'],
      ['a plain member', 'member-1'],
    ])('answers in the context shape, reading no address, to %s (#167)', async (_label, actorId) => {
      abilityService.getActingUserId.mockReturnValue(actorId);

      await expect(service.revokeInvite('hh-1', 'invite-1')).resolves.toBe(revocation.invite);
      await expect(service.approveInvite('hh-1', 'invite-1')).resolves.toBe(approval.invite);

      expect(db.invite.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('listInvites', () => {
    const query = (overrides: Partial<ListHouseholdInvitesQueryDto> = {}) =>
      Object.assign(paginationQuery({ limit: 10 }), overrides) as ListHouseholdInvitesQueryDto;

    const listedWhere = () => (db.invite.findMany.mock.calls[0]?.[0] as { where: Prisma.InviteWhereInput }).where;

    /** A listed row that `inviterId` sent. */
    const sentBy = (id: string, inviterId: string) =>
      contextView({ id, inviter: { id: inviterId, username: inviterId, profile: null } });

    /**
     * Answers every read after the list's with the stored columns it selects,
     * of the ids it names, so a row carries exactly what was read for it.
     */
    const storedColumns = (stored: ReadonlyArray<{ readonly id: string } & Record<string, unknown>>) =>
      db.invite.findMany.mockImplementation(((args: {
        where: { id: { in: string[] } };
        select: Record<string, unknown>;
      }) =>
        Promise.resolve(
          stored.filter((row) => args.where.id.in.includes(row.id)).map((row) => selected(row, args.select)),
        )) as never);

    /** The ids the reads after the list's asked `column` of. */
    const idsRead = (column: string) =>
      db.invite.findMany.mock.calls
        .slice(1)
        .map(([args]) => args as unknown as { where: { id: { in: string[] } }; select: Record<string, unknown> })
        .filter((args) => args.select[column] === true)
        .flatMap((args) => args.where.id.in);

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

      // A read changes no column, so it names none.
      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(
        Action.read,
        ResourceType.Invite,
        { householdId: 'hh-1', household: { members: ROSTER } },
        undefined,
      );
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

    // A plain member reads the list only through a grant beside their household
    // role, as staff who belong to the household do. The address on a row they
    // did not send is for the household's owners and admins (#167).
    it('reads the address and message for the rows a plain member sent, and for no others (#167)', async () => {
      abilityService.getActingUserId.mockReturnValue('member-1');
      const sent = sentBy('sent', 'member-1');
      const others = sentBy('others', 'owner-1');
      db.invite.findMany
        .mockResolvedValueOnce(resolves([sent, others]))
        .mockResolvedValueOnce(resolves([{ id: 'sent', inviteeEmail: 'sam@example.test', message: 'Join us' }]));
      db.invite.count.mockResolvedValue(2);

      const { rows, total } = await service.listInvites('hh-1', query());

      expect(db.invite.findMany).toHaveBeenLastCalledWith({
        where: { id: { in: ['sent'] }, inviterId: 'member-1' },
        select: { id: true, inviteeEmail: true, message: true },
      });
      expect(total).toBe(2);
      expect(rows[0]).toEqual(partyView({ id: 'sent', inviter: sent.inviter }));
      expect(rows[1]).toEqual(others);
    });

    it('reads no party columns when a plain member sent none of the rows (#167)', async () => {
      abilityService.getActingUserId.mockReturnValue('member-1');
      db.invite.findMany.mockResolvedValue(resolves([sentBy('invite-1', 'owner-1')]));

      await service.listInvites('hh-1', query());

      expect(db.invite.findMany).toHaveBeenCalledTimes(1);
    });

    describe("the address, for the household's owners and admins (#167)", () => {
      const sent = sentBy('sent', 'reader');
      const others = sentBy('others', 'member-1');

      beforeEach(() => {
        storedColumns([
          { id: 'sent', inviteeEmail: 'sam@example.test', message: 'Join us' },
          { id: 'others', inviteeEmail: 'kim@example.test', message: 'For Kim alone' },
        ]);
        db.invite.findMany.mockResolvedValueOnce(resolves([sent, others]));
        db.invite.count.mockResolvedValue(2);
        abilityService.getActingUserId.mockReturnValue('reader');
      });

      it('shows a household admin the address on an invite another member sent (#167)', async () => {
        db.householdMember.findMany.mockResolvedValue(
          resolves([...ROSTER, rosterRow('reader', SystemRole.HouseholdAdmin)]),
        );

        const { rows } = await service.listInvites('hh-1', query());

        expect(rows[0]).toEqual({ ...sent, inviteeEmail: 'sam@example.test', message: 'Join us' });
        expect(rows[1]).toEqual({ ...others, inviteeEmail: 'kim@example.test' });
        // The message is the parties' alone, so it is read for the reader's own
        // row and for no other.
        expect(idsRead('message')).toEqual(['sent']);
      });

      it('keeps the address from staff, who read every invite but hold no household role (#167)', async () => {
        // The roster does not name the reader: their read comes from a grant.
        const { rows } = await service.listInvites('hh-1', query());

        expect(rows[0]).toEqual({ ...sent, inviteeEmail: 'sam@example.test', message: 'Join us' });
        expect(rows[1]).toEqual(others);
        expect(idsRead('inviteeEmail')).toEqual(['sent']);
      });
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
