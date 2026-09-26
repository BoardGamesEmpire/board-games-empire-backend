import type { Household } from '@bge/database';
import { Action, HouseholdMembershipOrigin, InviteStatus, Prisma, ResourceType } from '@bge/database';
import { uniqueViolation as sharedUniqueViolation, uniqueViolationWithoutMeta } from '@bge/database/testing';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  paginationQuery,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaError } from '@status/codes';
import { HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT } from './constants/household.constants';
import { HouseholdService } from './household.service';
import { MEMBER_SELECT, PENDING_INVITE_SELECT } from './read-shapes';

const COND = { id: 'sentinel-condition' };

describe('HouseholdService', () => {
  let service: HouseholdService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId'>>;
  let permissions: jest.Mocked<Pick<PermissionsService, 'invalidateUser' | 'invalidateUsers'>>;
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue('user-1'),
    };
    permissions = {
      invalidateUser: jest.fn().mockResolvedValue(undefined),
      invalidateUsers: jest.fn().mockResolvedValue(undefined),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdService,
        // The REAL composer, over the mocked ability service. Substituting a
        // double here would make every where-clause assertion below a test of
        // the double rather than of the merge the reads actually depend on.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
        { provide: PermissionsService, useValue: permissions },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(HouseholdService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
  });

  afterEach(() => jest.clearAllMocks());

  it('getHouseholdById → read', async () => {
    db.household.findUnique.mockResolvedValue({ id: 'hh-1', members: [] } as unknown as HouseholdWithMembers);

    await service.getHouseholdById('hh-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.read);
    expect(db.household.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'hh-1', AND: [COND] }) }),
    );
  });

  // #297 / #296. The shapes themselves are pinned in `read-shapes.spec.ts`;
  // these pin that the reads actually USE them. Without this, the service could
  // regress to an inline `include:` — republishing `Invite.token` and the
  // membership provenance columns — while every shape spec still passed.
  it('shapes pending invites with PENDING_INVITE_SELECT, never the raw row', async () => {
    db.household.findUnique.mockResolvedValue({ id: 'hh-1', members: [] } as unknown as HouseholdWithMembers);

    await service.getHouseholdById('hh-1');

    const [{ include }] = db.household.findUnique.mock.calls[0] as [{ include: Record<string, unknown> }];

    expect(include.invites).toEqual({
      where: { AND: [{ status: InviteStatus.Pending }] },
      select: PENDING_INVITE_SELECT,
    });
  });

  it('shapes the detail roster with MEMBER_SELECT plus the exclusion join this read alone needs', async () => {
    db.household.findUnique.mockResolvedValue({ id: 'hh-1', members: [] } as unknown as HouseholdWithMembers);

    await service.getHouseholdById('hh-1');

    const [{ include }] = db.household.findUnique.mock.calls[0] as [{ include: Record<string, unknown> }];

    expect(include.members).toEqual({
      select: {
        ...MEMBER_SELECT,
        excludedFromHouseholds: { select: { gameCollectionId: true } },
      },
    });
  });

  it('shapes the list roster with MEMBER_SELECT', async () => {
    db.household.findMany.mockResolvedValue([]);
    db.household.count.mockResolvedValue(0);

    await service.getHouseholdsForUser(paginationQuery({ limit: 10 }));

    const [{ include }] = db.household.findMany.mock.calls[0] as [{ include: Record<string, unknown> }];

    expect(include.members).toEqual({ select: MEMBER_SELECT });
  });

  it('throws NotFound when the household does not exist (scoped read empty, probe finds nothing)', async () => {
    db.household.findUnique.mockResolvedValue(null);
    db.household.count.mockResolvedValue(0);

    await expect(service.getHouseholdById('hh-1')).rejects.toThrow(NotFoundException);
    expect(db.household.count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null } });
  });

  it('throws Forbidden when the household exists but is not visible to the actor', async () => {
    db.household.findUnique.mockResolvedValue(null);
    db.household.count.mockResolvedValue(1);

    await expect(service.getHouseholdById('hh-1')).rejects.toThrow(ForbiddenException);
  });

  it('samples member games DB-side and fetches only the sampled rows', async () => {
    db.household.findUnique.mockResolvedValue({
      id: 'hh-1',
      members: [
        {
          userId: 'member-1',
          user: { id: 'member-1', username: 'm1' },
          excludedFromHouseholds: [{ gameCollectionId: 'excluded-1' }],
        },
      ],
    } as unknown as HouseholdWithMembers);
    db.$queryRaw.mockResolvedValue([{ id: 'gc-1' }, { id: 'gc-2' }]);
    db.gameCollection.findMany.mockResolvedValue([
      { id: 'gc-1', platformGame: { id: 'pg-1', game: { id: 'g-1', title: 'A' } } },
      { id: 'gc-2', platformGame: { id: 'pg-2', game: { id: 'g-2', title: 'B' } } },
    ] as never);

    const result = await service.getHouseholdById('hh-1');

    // One bounded raw sample query...
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    // ...then a rich fetch scoped to only the sampled ids (never the full set).
    expect(db.gameCollection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['gc-1', 'gc-2'] } } }),
    );
    expect(result.members[0].user.gameCollections).toHaveLength(2);
  });

  it('skips the rich fetch when a member has no sampled games', async () => {
    db.household.findUnique.mockResolvedValue({
      id: 'hh-1',
      members: [{ userId: 'member-1', user: { id: 'member-1' }, excludedFromHouseholds: [] }],
    } as unknown as HouseholdWithMembers);
    db.$queryRaw.mockResolvedValue([]);

    const result = await service.getHouseholdById('hh-1');

    expect(db.gameCollection.findMany).not.toHaveBeenCalled();
    expect(result.members[0].user.gameCollections).toEqual([]);
  });

  it('create attributes the owner to the acting user (no userId param)', async () => {
    db.household.create.mockResolvedValue({ id: 'hh-1', createdById: 'user-1' } as Household);

    await service.create({ name: 'Home' } as never);

    expect(abilityService.getActingUserId).toHaveBeenCalledTimes(1);
    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
    expect(db.household.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdBy: { connect: { id: 'user-1' } },
          members: {
            // Provenance is asserted, not merely `userId` (#276). Both columns are
            // nullable, so dropping either from the nested create would otherwise
            // leave this suite green while the founder became indistinguishable
            // from a fixture row.
            create: expect.objectContaining({
              userId: 'user-1',
              origin: HouseholdMembershipOrigin.Founder,
              addedById: 'user-1',
            }),
          },
        }),
      }),
    );
    // The new owner's cached ability graph is evicted so their grants resolve.
    expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
  });

  describe('create idempotency (#210)', () => {
    /**
     * A P2002 in the shape Prisma actually raises, via `@bge/database`'s shared
     * factory. `target` is OPTIONAL and absent by default: omitting it reproduces
     * what `@prisma/client@7.8.0` + `@prisma/adapter-pg` reports, and every case in
     * this block used to pass one — which is why the shape-sniffing discriminator
     * this replaced was never once tested against reality.
     *
     * Fabricated centrally rather than here (#298). Four specs previously invented
     * their own payload, so each discriminator was only ever tested against the
     * mock that fed it, and no single place could be compared against a real
     * database. `apps/api-e2e/src/database/p2002-shape.spec.ts` is what keeps the
     * shared factory honest.
     */
    const uniqueViolation = (target?: string | string[]) =>
      target === undefined ? uniqueViolationWithoutMeta() : sharedUniqueViolation({ target });

    it('persists the client-supplied key on the row', async () => {
      db.household.create.mockResolvedValue({ id: 'hh-1' } as Household);

      await service.create({ name: 'Home', clientRequestId: 'key-1' });

      expect(db.household.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientRequestId: 'key-1' }) }),
      );
    });

    it('replays: returns the ORIGINAL row on a key conflict instead of surfacing it', async () => {
      const original = { id: 'hh-original', createdById: 'user-1', clientRequestId: 'key-1' } as Household;
      db.household.create.mockRejectedValue(uniqueViolation(HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT));
      db.household.findUnique.mockResolvedValue(original);

      await expect(service.create({ name: 'Home', clientRequestId: 'key-1' })).resolves.toBe(original);

      // The lookup omits `deletedAt: null` — the keyed create semantically
      // succeeded; that row is its canonical outcome even if since deleted.
      expect(db.household.findUnique).toHaveBeenCalledWith({
        where: { createdById_clientRequestId: { createdById: 'user-1', clientRequestId: 'key-1' } },
      });
      // Eviction runs on replay too: heals the committed-then-crashed-before-
      // eviction window of the original request. Idempotent and cheap.
      expect(permissions.invalidateUser).toHaveBeenCalledWith('user-1');
    });

    it('replays when the P2002 carries NO meta at all', async () => {
      // THE REGRESSION TEST. This is what Prisma 7 + PrismaPg actually raises,
      // and what the previous `meta.target` discriminator could never match: it
      // rethrew, so every keyed retry answered 500 — inverting #210's guarantee
      // on precisely the request it exists to make safe. Confirmed end-to-end in
      // apps/api-e2e/src/household/household-idempotency.spec.ts (#257).
      const original = { id: 'hh-original' } as Household;
      db.household.create.mockRejectedValue(uniqueViolation());
      db.household.findUnique.mockResolvedValue(original);

      await expect(service.create({ name: 'Home', clientRequestId: 'key-1' })).resolves.toBe(original);
    });

    it.each([
      ['the mapped constraint name', HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT],
      ['the Prisma field-name array', ['createdById', 'clientRequestId']],
      ['the raw column names', ['created_by_id', 'client_request_id']],
      ['an unrecognized string', 'some_future_prisma_spelling'],
    ])('replays regardless of the reported target shape: %s', async (_label, target) => {
      // Recovery keys off the ROW, not the error shape, so none of these are
      // special-cased any more. Kept as a set because the shape is exactly what
      // drifts across Prisma versions, and the point is that drift no longer
      // changes the outcome.
      const original = { id: 'hh-original' } as Household;
      db.household.create.mockRejectedValue(uniqueViolation(target));
      db.household.findUnique.mockResolvedValue(original);

      await expect(service.create({ name: 'Home', clientRequestId: 'key-1' })).resolves.toBe(original);
    });

    it('returns a soft-deleted original as-is (deletedAt visible for client reconciliation)', async () => {
      const tombstoned = { id: 'hh-original', deletedAt: new Date('2026-08-01T00:00:00Z') } as Household;
      db.household.create.mockRejectedValue(uniqueViolation(HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT));
      db.household.findUnique.mockResolvedValue(tombstoned);

      const result = await service.create({ name: 'Home', clientRequestId: 'key-1' });

      expect(result).toBe(tombstoned);
      expect(result.deletedAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    });

    it('rethrows a P2002 from a different unique, because no row exists under the key', async () => {
      // The nested member insert tripping `(householdId, userId)` is the genuine
      // case. It is now declined by the LOOKUP rather than by inspecting the
      // error: no row under this key means nothing committed, so there is no
      // replay to serve. The lookup IS reached, unlike before — that extra query
      // on the error path is the cost of not depending on `meta`.
      const error = uniqueViolation(['householdId', 'userId']);
      db.household.create.mockRejectedValue(error);
      db.household.findUnique.mockResolvedValue(null);

      await expect(service.create({ name: 'Home', clientRequestId: 'key-1' })).rejects.toBe(error);
      expect(db.household.findUnique).toHaveBeenCalled();
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('rethrows a matching P2002 when no key was supplied (keyless creates never replay)', async () => {
      const error = uniqueViolation(HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT);
      db.household.create.mockRejectedValue(error);

      await expect(service.create({ name: 'Home' })).rejects.toBe(error);
      expect(db.household.findUnique).not.toHaveBeenCalled();
    });

    it('rethrows the original error when the replay lookup finds nothing', async () => {
      const error = uniqueViolation(HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT);
      db.household.create.mockRejectedValue(error);
      db.household.findUnique.mockResolvedValue(null);

      await expect(service.create({ name: 'Home', clientRequestId: 'key-1' })).rejects.toBe(error);
      expect(permissions.invalidateUser).not.toHaveBeenCalled();
    });

    it('rethrows non-unique-constraint failures untouched', async () => {
      const error = new Error('connection reset');
      db.household.create.mockRejectedValue(error);

      await expect(service.create({ name: 'Home', clientRequestId: 'key-1' })).rejects.toBe(error);
      expect(db.household.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
    ])('treats %s as no key (in-process callers skip DTO validation)', async (_label, key) => {
      db.household.create.mockResolvedValue({ id: 'hh-1' } as Household);

      await service.create({ name: 'Home', clientRequestId: key });

      // Persisting '' would put every blank-key create by this user into one
      // shared bucket, silently replaying unrelated creates.
      expect(db.household.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientRequestId: undefined }) }),
      );
    });

    it('never replays a blank key, even on an idempotency-unique conflict', async () => {
      const error = uniqueViolation(HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT);
      db.household.create.mockRejectedValue(error);

      await expect(service.create({ name: 'Home', clientRequestId: '' })).rejects.toBe(error);
      expect(db.household.findUnique).not.toHaveBeenCalled();
    });

    it('trims a padded key so the DTO and in-process paths share one bucket', async () => {
      const original = { id: 'hh-original' } as Household;
      db.household.create.mockRejectedValue(uniqueViolation(HOUSEHOLD_CLIENT_REQUEST_ID_CONSTRAINT));
      db.household.findUnique.mockResolvedValue(original);

      await expect(service.create({ name: 'Home', clientRequestId: '  key-1  ' })).resolves.toBe(original);

      expect(db.household.findUnique).toHaveBeenCalledWith({
        where: { createdById_clientRequestId: { createdById: 'user-1', clientRequestId: 'key-1' } },
      });
    });
  });

  it('updateHousehold → update', async () => {
    db.household.count.mockResolvedValue(1);
    db.household.update.mockResolvedValue({ id: 'hh-1' } as Household);

    await service.updateHousehold('hh-1', { name: 'New' } as never);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.update);
    expect(db.household.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'hh-1', AND: [COND] }) }),
    );
  });

  it('rejects an empty update patch', async () => {
    await expect(service.updateHousehold('hh-1', {} as never)).rejects.toThrow(BadRequestException);
  });

  it('deleteHousehold soft-deletes under the delete policy, revokes pending invites, and evicts member caches', async () => {
    db.household.count.mockResolvedValue(1);
    unwrapTransaction(db);
    db.household.update.mockResolvedValue({ id: 'hh-1' } as Household);
    db.invite.updateMany.mockResolvedValue({ count: 2 } as never);
    db.householdMember.findMany.mockResolvedValue([{ userId: 'user-1' }, { userId: 'user-2' }] as never);

    await service.deleteHousehold('hh-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.delete);
    // Existence probed first (excludes soft-deleted).
    expect(db.household.count).toHaveBeenCalledWith({ where: { id: 'hh-1', deletedAt: null } });
    // Soft delete (stamp deletedAt), not a hard delete, gated by the scoped where.
    expect(db.household.delete).not.toHaveBeenCalled();
    expect(db.household.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'hh-1', deletedAt: null, AND: [COND] }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    // Outstanding invites to the dead household are revoked.
    expect(db.invite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          householdId: 'hh-1',
          status: { in: [InviteStatus.Pending, InviteStatus.AwaitingApproval] },
        }),
        data: { status: InviteStatus.Revoked },
      }),
    );
    // Every member's cached ability graph is evicted (household left their surface).
    expect(permissions.invalidateUsers).toHaveBeenCalledWith(['user-1', 'user-2']);
  });

  it('deleteHousehold 404s when the household does not exist (probe finds nothing)', async () => {
    db.household.count.mockResolvedValue(0);

    await expect(service.deleteHousehold('hh-1')).rejects.toThrow(NotFoundException);
    // Existence fails before any write — the transaction never runs.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(permissions.invalidateUsers).not.toHaveBeenCalled();
  });

  it('deleteHousehold 403s when it exists but the actor may not delete it (scoped update misses)', async () => {
    db.household.count.mockResolvedValue(1);
    unwrapTransaction(db);
    db.household.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('no rows', {
        code: PrismaError.DependentRecordNotFound,
        clientVersion: 'test',
      }),
    );

    await expect(service.deleteHousehold('hh-1')).rejects.toThrow(ForbiddenException);
    // The failed update rolls the transaction back — no invalidation runs.
    expect(permissions.invalidateUsers).not.toHaveBeenCalled();
  });

  /**
   * #417. The `paginated()` guard reads a CLS registry keyed per resource type
   * per REQUEST, not per call: a read that reaches the database on its ceiling
   * alone records nothing, and now that `Household` has left
   * `PENDING_SCOPE_SWEEP` the envelope built over it throws
   * `ListScopeNotComposedError`. A regression that stops this read composing
   * its scope therefore answers 500 rather than merely returning too much,
   * which is why the first test pins the composer call itself.
   */
  describe('getHouseholdsForUser, as a converted household list', () => {
    const read = (subject: HouseholdService, query = paginationQuery({ limit: 10 })) =>
      subject.getHouseholdsForUser(query);

    beforeEach(() => {
      db.household.findMany.mockResolvedValue([]);
      db.household.count.mockResolvedValue(0);
    });

    it('asks the composer for its where clause, declaring its own scope', async () => {
      await read(service);

      expect(compose).toHaveBeenCalledWith(ResourceType.Household, Action.read, {
        deletedAt: null,
        members: { some: { userId: 'user-1' } },
      });
    });

    // Asking is not enough — the query has to use the answer. The ceiling is
    // still ANDed in, but it clips the declared scope rather than supplying
    // it. Before #417 it WAS the scope of `getHouseholdsForUser`, so one route
    // returned a plain user their memberships, a friend those friends'
    // `Friends`-visible households as well, and staff every household on the
    // server, with `pagination.total` scoped the same way so a client could
    // not tell which contract it had been given.
    //
    // The other two halves stay as well. `deletedAt: null`, because a soft
    // delete keeps the household's member rows, so the membership clause alone
    // still matches a dead household. The ceiling, because for an `apiKey`
    // actor it carries the key ∩ owner floor, and dropping it would widen a
    // narrow key to the owner's whole membership list.
    it('queries with the composed clause, the ceiling clipping its scope rather than supplying it', async () => {
      await read(service);

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.read);
      expect(db.household.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null, members: { some: { userId: 'user-1' } }, AND: [COND] }),
        }),
      );
    });

    // #230: `total` is only trustworthy against the rows because both come
    // from one snapshot, and nothing in the read itself enforces that — the
    // mock resolves the operation array at any isolation level, so a
    // regression to the Prisma default would be invisible without pinning it
    // here.
    it('reads the rows and the count in one REPEATABLE READ transaction', async () => {
      await read(service);

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // The count must see the membership clause too, or `total` describes a
    // different population than the rows and the client pages through a number
    // that was never true for it.
    it('counts over the same where clause as the rows', async () => {
      await read(service);

      const [findManyArgs] = db.household.findMany.mock.calls[0] as [{ where: unknown }];
      expect(db.household.count).toHaveBeenCalledWith({ where: findManyArgs.where });
    });

    // A page boundary needs a total order; `createdAt` alone lets rows created
    // in one transaction share a key and drift between requests.
    it('orders totally, so pages cannot drift between requests', async () => {
      await read(service);

      expect(db.household.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
    });

    it('applies the requested page window', async () => {
      await read(service, paginationQuery({ page: 3, limit: 10 }));

      expect(db.household.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
    });

    // PROVISIONAL (#417). A first-person scope has no meaning for an actor
    // with no user behind it, and the rejection must stay a rejection: an empty
    // page tells a client its memberships were removed, which is a different
    // and much more damaging claim than "you cannot ask this". For
    // `getHouseholdsForUser` this is a real behaviour change — those actors
    // previously received whatever their ceiling admitted. #395 revisits it.
    it('refuses an actor kind with no user behind it rather than answering an empty page', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      await expect(read(service)).rejects.toThrow(ForbiddenException);
      expect(db.household.findMany).not.toHaveBeenCalled();
    });

    // `getActingUserId` phrases its rejection as being about user-attributed
    // WRITES. Accurate for its usual callers, wrong on a GET — a caller told
    // they "cannot perform writes" by a list endpoint looks for a bug that is
    // not there.
    //
    // Both refusals are `t()` markers, translated only at the edge, so this
    // pins the key the caller receives: the read's own, not the write-flavoured
    // one passed through.
    it('does not answer a read with a message about writes', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await read(service).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
    });

    // A MISSING actor is not a denied one: `getActingUserId` throws a plain
    // Error when nothing primed the context, which is a programmer error and
    // must stay a 500 rather than being laundered into a 403.
    it('lets an unprimed context through as the programmer error it is', async () => {
      const unprimed = new Error('getActingUserId called with no actor in context');
      abilityService.getActingUserId.mockImplementation(() => {
        throw unprimed;
      });

      await expect(read(service)).rejects.toThrow(unprimed);
      await expect(read(service)).rejects.not.toThrow(ForbiddenException);
    });

    it('surfaces the empty-conditions Forbidden backstop', async () => {
      abilityService.getCurrentResourceConditions.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(read(service)).rejects.toThrow(ForbiddenException);
    });
  });
});

interface HouseholdWithMembers extends Household {
  members: { userId: string }[];
}
