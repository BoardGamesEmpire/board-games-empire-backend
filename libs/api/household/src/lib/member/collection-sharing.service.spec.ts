import { Action, Prisma, ResourceType, SystemRole } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, unwrapTransaction } from '@bge/testing';
import { WebhookEventType } from '@bge/webhooks';
import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http, PrismaError } from '@status/codes';
import { HouseholdEvents } from '../constants/household-events.constant';
import { HouseholdEventPublisher } from '../events/household-event.publisher';
import {
  HouseholdExcludedGameAddedEvent,
  HouseholdExcludedGameRemovedEvent,
  HouseholdMemberCollectionSharingChangedEvent,
} from '../events/household.events';
import { MEMBER_SELECT } from '../read-shapes';
import { CollectionSharingService, EXCLUDED_GAME_SELECT } from './collection-sharing.service';

const COND = { id: 'sentinel-condition' };
const NOW = new Date('2026-11-23T12:00:00Z');

const resolves = (value: unknown) => value as never;

const MEMBER = {
  id: 'member-1',
  userId: 'user-1',
  householdId: 'hh-1',
  collectionSharing: true,
  createdAt: NOW,
  updatedAt: NOW,
  user: { id: 'user-1', username: 'sam', profile: { avatarUrl: null, displayName: 'Sam Doe' } },
  role: { role: { id: 'role-member', name: SystemRole.HouseholdMember } },
};

const GAME = { id: 'game-1', title: 'Azul', thumbnail: null, description: null };

const EXCLUDED_ROW = {
  gameCollectionId: 'entry-1',
  excludedReason: 'Too fragile to lend',
  excludedAt: NOW,
  gameCollection: { platformGame: { id: 'pg-1', game: GAME } },
};

const EXCLUDED_VIEW = {
  collectionEntryId: 'entry-1',
  reason: 'Too fragile to lend',
  excludedAt: NOW,
  platformGame: { id: 'pg-1', game: GAME },
};

/** The caller's own membership, as every route here looks it up (#170). */
const ownMembershipWhere = (userId: string, conditions: unknown[] = [COND]) => ({
  householdId: 'hh-1',
  userId,
  household: { deletedAt: null },
  AND: conditions,
});

/**
 * A P2003 in the shape `@prisma/adapter-pg@7.10` raises: the constraint that
 * fired under `meta.driverAdapterError.cause.constraint`, as an index name, or
 * as the column when Postgres names one. `constraint` omitted models a payload
 * that names nothing (#170).
 */
const foreignKeyViolation = (constraint?: { fields?: string[]; index?: string }) => {
  const driverAdapterError = Object.assign(new Error('ForeignKeyConstraintViolation'), {
    name: 'DriverAdapterError',
    cause: {
      originalCode: '23503',
      originalMessage: 'insert or update on table "excluded_games" violates foreign key constraint',
      kind: 'ForeignKeyConstraintViolation',
      ...(constraint ? { constraint } : {}),
    },
  });

  return new Prisma.PrismaClientKnownRequestError('fk', {
    code: PrismaError.ForeignKeyConstraintViolation,
    clientVersion: 'test',
    meta: { modelName: 'ExcludedGame', driverAdapterError },
  });
};

describe('CollectionSharingService', () => {
  let service: CollectionSharingService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getActingUserId' | 'getCurrentResourceConditions'>>;
  let events: jest.Mocked<Pick<EventEmitter2, 'emit'>>;

  beforeEach(async () => {
    abilityService = {
      getActingUserId: jest.fn().mockReturnValue('user-1'),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
    };
    events = { emit: jest.fn().mockReturnValue(true) };

    const ctx = await createTestingModuleWithDb({
      providers: [
        CollectionSharingService,
        // The real composer over the mocked ability service, so the where
        // clauses asserted below are the merge the reads run.
        ScopeComposer,
        // The real publisher over a mocked bus, so each `events.emit`
        // assertion below is what the audit and webhook listeners receive.
        HouseholdEventPublisher,
        { provide: EventEmitter2, useValue: events },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(CollectionSharingService);

    unwrapTransaction(db);
    db.householdMember.findFirst.mockResolvedValue(resolves(MEMBER));
    db.householdMember.count.mockResolvedValue(0);
    db.householdMember.updateMany.mockResolvedValue({ count: 1 });
    db.householdMember.findUnique.mockResolvedValue(resolves({ ...MEMBER, collectionSharing: false }));
    db.gameCollection.findFirst.mockResolvedValue(resolves({ id: 'entry-1' }));
    db.excludedGame.createMany.mockResolvedValue({ count: 1 });
    db.excludedGame.findUniqueOrThrow.mockResolvedValue(resolves(EXCLUDED_ROW));
    db.excludedGame.updateMany.mockResolvedValue({ count: 1 });
    db.excludedGame.findMany.mockResolvedValue(resolves([EXCLUDED_ROW]));
    db.excludedGame.deleteMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => jest.clearAllMocks());

  /** The names published on the bus, in order. */
  const emittedNames = () => events.emit.mock.calls.map(([name]) => String(name));

  /** What was published under `name`. */
  const emittedUnder = (name: string): unknown => events.emit.mock.calls.find(([emitted]) => emitted === name)?.[1];

  /** Each route, as a member calls it. */
  const routes = {
    setCollectionSharing: () => service.setCollectionSharing('hh-1', { collectionSharing: false }),
    listExcludedGames: () => service.listExcludedGames('hh-1'),
    excludeGame: () => service.excludeGame('hh-1', { collectionEntryId: 'entry-1' }),
    includeGame: () => service.includeGame('hh-1', 'entry-1'),
  };

  const expectNoWrite = () => {
    expect(db.householdMember.updateMany).not.toHaveBeenCalled();
    expect(db.excludedGame.createMany).not.toHaveBeenCalled();
    expect(db.excludedGame.update).not.toHaveBeenCalled();
    expect(db.excludedGame.updateMany).not.toHaveBeenCalled();
    expect(db.excludedGame.deleteMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  };

  describe('the caller’s own membership (#367, #170)', () => {
    it.each(Object.entries(routes))(
      '%s refuses a member who isn’t in the household with 404 (#170)',
      async (_name, call) => {
        db.householdMember.findFirst.mockResolvedValue(null);

        await expect(call()).rejects.toMatchObject({
          status: Http.NotFound,
          response: expect.objectContaining({ key: 'errors.household.not_a_member' }),
        });
        expectNoWrite();
      },
    );

    it('refuses a member of a deleted household with 404, as it refuses a non-member (#170)', async () => {
      // The household's liveness is part of both lookups, so a membership of a
      // deleted household is no membership at all here.
      db.householdMember.findFirst.mockResolvedValue(null);

      await expect(routes.setCollectionSharing()).rejects.toMatchObject({ status: Http.NotFound });

      expect(db.householdMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ household: { deletedAt: null } }) }),
      );
      expect(db.householdMember.count).toHaveBeenCalledWith({
        where: { householdId: 'hh-1', userId: 'user-1', household: { deletedAt: null } },
      });
      expectNoWrite();
    });

    it('refuses with 403 a member whose own grant does not reach their membership (#170)', async () => {
      // An API key scoped to another household passes the route's type-level
      // gate; its scope misses the row, which exists.
      db.householdMember.findFirst.mockResolvedValue(null);
      db.householdMember.count.mockResolvedValue(1);

      await expect(routes.excludeGame()).rejects.toBeInstanceOf(ForbiddenException);
      expectNoWrite();
    });

    it('pins the caller’s own membership even for an owner whose manage scope covers the roster (#170)', async () => {
      // An owner's `manage` implies `update` on every member of the household,
      // so the ceiling alone would match whichever row came first.
      const rosterWide = { householdId: 'hh-1' };
      abilityService.getActingUserId.mockReturnValue('owner-1');
      abilityService.getCurrentResourceConditions.mockReturnValue([rosterWide]);

      for (const call of Object.values(routes)) {
        await call();
      }

      for (const [args] of db.householdMember.findFirst.mock.calls) {
        expect(args).toEqual(expect.objectContaining({ where: ownMembershipWhere('owner-1', [rosterWide]) }));
      }

      expect(db.householdMember.findFirst).toHaveBeenCalledTimes(4);
    });

    it('asks the update scope for each write and the read scope for the list (#170)', async () => {
      await routes.setCollectionSharing();
      await routes.excludeGame();
      await routes.includeGame();
      await routes.listExcludedGames();

      expect(abilityService.getCurrentResourceConditions.mock.calls).toEqual([
        [ResourceType.HouseholdMember, Action.update],
        [ResourceType.HouseholdMember, Action.update],
        [ResourceType.HouseholdMember, Action.update],
        [ResourceType.HouseholdMember, Action.read],
      ]);
    });

    it.each(Object.entries(routes))(
      '%s refuses an actor with no user behind it with 403, before any read (#170)',
      async (_name, call) => {
        abilityService.getActingUserId.mockImplementation(() => {
          throw new ForbiddenException();
        });

        await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
        expect(db.householdMember.findFirst).not.toHaveBeenCalled();
      },
    );
  });

  describe('setCollectionSharing (#367)', () => {
    it('turns collection sharing off for the caller’s own membership and returns the roster row (#367)', async () => {
      await expect(routes.setCollectionSharing()).resolves.toEqual({ ...MEMBER, collectionSharing: false });

      expect(db.householdMember.findFirst).toHaveBeenCalledWith({
        where: ownMembershipWhere('user-1'),
        select: MEMBER_SELECT,
      });
      // Conditional on the value it replaces, so of two toggles racing, only
      // the one that changed it reports a change.
      expect(db.householdMember.updateMany).toHaveBeenCalledWith({
        where: { id: 'member-1', collectionSharing: true },
        data: { collectionSharing: false },
      });
      expect(db.householdMember.findUnique).toHaveBeenCalledWith({ where: { id: 'member-1' }, select: MEMBER_SELECT });
    });

    it('runs the read of the value before, the write and the read after in one transaction (#367)', async () => {
      const inside: string[] = [];
      db.$transaction.mockImplementation((async (callback: (tx: MockDatabaseService) => Promise<unknown>) => {
        inside.push('begin');
        const result = await callback(db);
        inside.push('commit');

        return result;
      }) as never);
      db.householdMember.findFirst.mockImplementation((async () => {
        inside.push('read');

        return MEMBER;
      }) as never);
      db.householdMember.updateMany.mockImplementation((async () => {
        inside.push('write');

        return { count: 1 };
      }) as never);
      events.emit.mockImplementation(() => {
        inside.push('publish');

        return true;
      });

      await routes.setCollectionSharing();

      expect(inside).toEqual(['begin', 'read', 'write', 'commit', 'publish', 'publish']);
    });

    it('publishes collection sharing changes only when the value changes (#367)', async () => {
      await routes.setCollectionSharing();

      expect(emittedNames()).toEqual([
        HouseholdEvents.MemberCollectionSharingChanged,
        WebhookEventType.HouseholdMemberCollectionSharingChanged,
      ]);

      const event = emittedUnder(HouseholdEvents.MemberCollectionSharingChanged);
      expect(event).toBeInstanceOf(HouseholdMemberCollectionSharingChangedEvent);
      expect(event).toMatchObject({
        before: { householdId: 'hh-1', memberId: 'member-1', userId: 'user-1', collectionSharing: true },
        after: { householdId: 'hh-1', memberId: 'member-1', userId: 'user-1', collectionSharing: false },
      });
      // Ids only, as every membership webhook carries (#245).
      expect(emittedUnder(WebhookEventType.HouseholdMemberCollectionSharingChanged)).toMatchObject({
        data: { householdId: 'hh-1', memberId: 'member-1', userId: 'user-1' },
      });

      // Already off: nothing changes, so nothing is published.
      events.emit.mockClear();
      db.householdMember.findFirst.mockResolvedValue(resolves({ ...MEMBER, collectionSharing: false }));
      db.householdMember.updateMany.mockResolvedValue({ count: 0 });

      await routes.setCollectionSharing();

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('publishes nothing when a toggle that landed first already made the change (#367)', async () => {
      // Read as on before the other toggle committed; the conditional write
      // then finds it off and changes nothing.
      db.householdMember.updateMany.mockResolvedValue({ count: 0 });

      await expect(routes.setCollectionSharing()).resolves.toMatchObject({ collectionSharing: false });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('answers 404 when the member left while the toggle waited (#367)', async () => {
      db.householdMember.updateMany.mockResolvedValue({ count: 0 });
      db.householdMember.findUnique.mockResolvedValue(null);

      await expect(routes.setCollectionSharing()).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.not_a_member' }),
      });
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('listExcludedGames (#170)', () => {
    it('lists the caller’s own excluded games for this household, newest first, of their live entries (#170)', async () => {
      await expect(routes.listExcludedGames()).resolves.toEqual([EXCLUDED_VIEW]);

      expect(db.householdMember.findFirst).toHaveBeenCalledWith({
        where: ownMembershipWhere('user-1'),
        select: { id: true, householdId: true, userId: true },
      });
      expect(db.excludedGame.findMany).toHaveBeenCalledWith({
        where: { householdMemberId: 'member-1', gameCollection: { userId: 'user-1', deletedAt: null } },
        orderBy: [{ excludedAt: 'desc' }, { id: 'desc' }],
        select: EXCLUDED_GAME_SELECT,
      });
    });
  });

  describe('excludeGame (#170)', () => {
    it('records the exclusion against the caller’s own membership (#170)', async () => {
      await expect(
        service.excludeGame('hh-1', { collectionEntryId: 'entry-1', reason: 'Too fragile to lend' }),
      ).resolves.toEqual(EXCLUDED_VIEW);

      expect(db.excludedGame.createMany).toHaveBeenCalledWith({
        data: [{ householdMemberId: 'member-1', gameCollectionId: 'entry-1', excludedReason: 'Too fragile to lend' }],
        skipDuplicates: true,
      });
      expect(db.excludedGame.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { householdMemberId_gameCollectionId: { householdMemberId: 'member-1', gameCollectionId: 'entry-1' } },
        select: EXCLUDED_GAME_SELECT,
      });
      expect(db.excludedGame.updateMany).not.toHaveBeenCalled();
    });

    it('stores no reason as null (#170)', async () => {
      await service.excludeGame('hh-1', { collectionEntryId: 'entry-1', reason: null });

      expect(db.excludedGame.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ excludedReason: null })] }),
      );
    });

    it('refuses another member’s entry with the same 404 as a missing one, and writes nothing (#170)', async () => {
      // Every game pool read hands out another member's entry id; the lookup
      // pins the caller's own user, so that entry reads as no entry at all.
      db.gameCollection.findFirst.mockResolvedValue(null);

      await expect(routes.excludeGame()).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.collection_entry_not_found', args: undefined }),
      });

      expect(db.gameCollection.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'entry-1', userId: 'user-1' }) }),
      );
      expectNoWrite();
    });

    it('refuses the caller’s own removed entry with the same 404, and writes nothing (#170)', async () => {
      // A soft-deleted entry of the caller's falls outside the live-entry
      // lookup, so it can't be excluded until it is added again.
      db.gameCollection.findFirst.mockResolvedValue(null);

      await expect(routes.excludeGame()).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.collection_entry_not_found' }),
      });

      expect(db.gameCollection.findFirst).toHaveBeenCalledWith({
        where: { id: 'entry-1', userId: 'user-1', deletedAt: null },
        select: { id: true },
      });
      expectNoWrite();
    });

    it('replaces the reason on a repeat, and publishes the added event only on create (#170)', async () => {
      db.excludedGame.createMany.mockResolvedValue({ count: 0 });
      db.excludedGame.findUniqueOrThrow.mockResolvedValue(
        resolves({ ...EXCLUDED_ROW, excludedReason: 'Missing a tile' }),
      );

      await expect(
        service.excludeGame('hh-1', { collectionEntryId: 'entry-1', reason: 'Missing a tile' }),
      ).resolves.toEqual({ ...EXCLUDED_VIEW, reason: 'Missing a tile' });

      expect(db.excludedGame.updateMany).toHaveBeenCalledWith({
        where: { householdMemberId: 'member-1', gameCollectionId: 'entry-1' },
        data: { excludedReason: 'Missing a tile' },
      });
      expect(db.excludedGame.createMany).toHaveBeenCalledTimes(1);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('inserts again, as a create, when a racing include removed the excluded game the insert skipped (#170)', async () => {
      // The insert skips the duplicate, then a racing DELETE commits, so the
      // replace finds no row: the exclusion is written fresh, and published.
      db.excludedGame.createMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
      db.excludedGame.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.excludeGame('hh-1', { collectionEntryId: 'entry-1', reason: 'Too fragile to lend' }),
      ).resolves.toEqual(EXCLUDED_VIEW);

      expect(db.excludedGame.createMany).toHaveBeenCalledTimes(2);
      expect(db.excludedGame.createMany).toHaveBeenLastCalledWith({
        data: [{ householdMemberId: 'member-1', gameCollectionId: 'entry-1', excludedReason: 'Too fragile to lend' }],
        skipDuplicates: true,
      });
      expect(db.excludedGame.update).not.toHaveBeenCalled();
      expect(emittedNames()).toEqual([HouseholdEvents.ExcludedGameAdded, WebhookEventType.HouseholdExcludedGameAdded]);
    });

    it('publishes nothing when a third racing call re-created the excluded game before the second insert (#170)', async () => {
      db.excludedGame.createMany.mockResolvedValue({ count: 0 });
      db.excludedGame.updateMany.mockResolvedValue({ count: 0 });

      await expect(routes.excludeGame()).resolves.toEqual(EXCLUDED_VIEW);

      expect(db.excludedGame.createMany).toHaveBeenCalledTimes(2);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it.each([
      ['its constraint name', { index: 'excluded_games_household_member_id_fkey' }],
      ['its column', { fields: ['household_member_id'] }],
    ])(
      'answers 404 as no membership, not 500, when the member left before the exclusion was written, named by %s (#170)',
      async (_how, constraint) => {
        db.excludedGame.createMany.mockRejectedValue(foreignKeyViolation(constraint));

        await expect(routes.excludeGame()).rejects.toMatchObject({
          status: Http.NotFound,
          response: expect.objectContaining({ key: 'errors.household.not_a_member' }),
        });
        expect(events.emit).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['the collection entry’s foreign key', { index: 'excluded_games_game_collection_id_fkey' }],
      ['an unnamed foreign key', undefined],
    ])(
      'answers the collection entry 404, not 500, when the insert fails %s: the entry was deleted mid-call (#170)',
      async (_which, constraint) => {
        db.excludedGame.createMany.mockRejectedValue(foreignKeyViolation(constraint));

        await expect(routes.excludeGame()).rejects.toMatchObject({
          status: Http.NotFound,
          response: expect.objectContaining({ key: 'errors.household.collection_entry_not_found' }),
        });
        expect(events.emit).not.toHaveBeenCalled();
      },
    );

    it('publishes the excluded-game events without the reason (#170)', async () => {
      await service.excludeGame('hh-1', { collectionEntryId: 'entry-1', reason: 'Too fragile to lend' });

      expect(emittedNames()).toEqual([HouseholdEvents.ExcludedGameAdded, WebhookEventType.HouseholdExcludedGameAdded]);

      const added = emittedUnder(HouseholdEvents.ExcludedGameAdded);
      expect(added).toBeInstanceOf(HouseholdExcludedGameAddedEvent);
      expect(added).toMatchObject({
        after: { householdId: 'hh-1', memberId: 'member-1', userId: 'user-1', collectionEntryId: 'entry-1' },
      });
      expect(emittedUnder(WebhookEventType.HouseholdExcludedGameAdded)).toMatchObject({
        data: { householdId: 'hh-1', memberId: 'member-1', userId: 'user-1', collectionEntryId: 'entry-1' },
      });

      const addedPayloads = events.emit.mock.calls.map(([, payload]) => payload);
      events.emit.mockClear();
      await routes.includeGame();

      expect(emittedNames()).toEqual([
        HouseholdEvents.ExcludedGameRemoved,
        WebhookEventType.HouseholdExcludedGameRemoved,
      ]);
      expect(emittedUnder(HouseholdEvents.ExcludedGameRemoved)).toBeInstanceOf(HouseholdExcludedGameRemovedEvent);
      expect(emittedUnder(HouseholdEvents.ExcludedGameRemoved)).toMatchObject({
        before: { householdId: 'hh-1', memberId: 'member-1', userId: 'user-1', collectionEntryId: 'entry-1' },
      });

      // Every payload published by both, the audit events and the webhook
      // envelopes alike, carries no reason under any key: the reason is the
      // member's alone.
      const published = JSON.stringify([...addedPayloads, ...events.emit.mock.calls.map(([, payload]) => payload)]);
      expect(published).not.toMatch(/reason/i);
      expect(published).not.toContain('Too fragile to lend');
    });
  });

  describe('includeGame (#170)', () => {
    it('removes the exclusion from the caller’s own membership (#170)', async () => {
      await expect(routes.includeGame()).resolves.toBeUndefined();

      expect(db.excludedGame.deleteMany).toHaveBeenCalledWith({
        where: { householdMemberId: 'member-1', gameCollectionId: 'entry-1' },
      });
    });

    it('answers 404 when the entry is not excluded, and publishes nothing (#170)', async () => {
      db.excludedGame.deleteMany.mockResolvedValue({ count: 0 });

      await expect(routes.includeGame()).rejects.toMatchObject({
        status: Http.NotFound,
        response: expect.objectContaining({ key: 'errors.household.excluded_game_not_found', args: undefined }),
      });
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
