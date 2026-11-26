import type { CollectionRatingChange, GameCollection } from '@bge/database';
import { Action, DatePrecision, GameMedium, Prisma, ResourceType } from '@bge/database';
import { uniqueViolation } from '@bge/database/testing';
import { syncCollectionEntrySupply } from '@bge/event';
import { AbilityService } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb, rawQueryText, unwrapTransaction } from '@bge/testing';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  appendRatingChange,
  appendRatingChangeIfChanged,
  CollectionRatingService,
  RATING_CHANGE_SELECT,
} from './collection-rating.service';
import type { RatingRevisionValues } from './collection-revisions';
import { RATING_REVISION_SELECT, ratingRevisionValues } from './collection-revisions';
import { CollectionWriteService } from './collection-write.service';

// The supply sync has its own spec in `@bge/event`; a rating change never reaches it (#1231).
jest.mock('@bge/event', () => ({
  syncCollectionEntrySupply: jest.fn(),
  emitCollectionSupplyChanges: jest.fn(),
}));

const syncSupply = jest.mocked(syncCollectionEntrySupply);

const COND = { id: 'sentinel-condition' };
const ME = 'user-1';

/** The entry's row as `lockEntry` answers it (#1231). */
const LOCKED = { deletedAt: null, medium: GameMedium.Physical, platformGameId: 'pg-1', userId: ME };

/** A rating change row as the routes read it: a 7 on 2019-03-02, unless given (#1231). */
const changeRow = (overrides: Partial<CollectionRatingChange> = {}) => ({
  createdAt: new Date('2026-11-01T00:00:00Z'),
  id: 'rc-1',
  occurredOn: new Date('2019-03-02T00:00:00Z'),
  occurredOnPrecision: DatePrecision.Day,
  rating: 7,
  retractedAt: null,
  ...overrides,
});

/** A revision's stored values, as `ratingRevisionValues` writes them (#1231). */
const storedValues = (overrides: Partial<RatingRevisionValues> = {}): RatingRevisionValues => ({
  occurredOn: '2018-01-01',
  occurredOnPrecision: DatePrecision.Year,
  rating: 5,
  ...overrides,
});

describe('appendRatingChange (#1231)', () => {
  it('writes the change dated today in UTC, at day precision, whatever the server zone', async () => {
    const create = jest.fn().mockResolvedValue({});
    // 23:30 in New York is already the next day in UTC.
    const now = new Date('2026-11-26T23:30:00-05:00');

    await appendRatingChange({ collectionRatingChange: { create } } as never, 'gc-1', 7, now);

    expect(create).toHaveBeenCalledWith({
      data: {
        entryId: 'gc-1',
        occurredOn: new Date('2026-11-27T00:00:00Z'),
        occurredOnPrecision: DatePrecision.Day,
        rating: 7,
      },
      select: { id: true },
    });
  });

  it('writes a change with no value when the rating was cleared', async () => {
    const create = jest.fn().mockResolvedValue({});

    await appendRatingChange({ collectionRatingChange: { create } } as never, 'gc-1', null, new Date());

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rating: null }) }));
  });
});

// The one guard every write of the entry's rating shares: a rating sent that
// differs from the locked row's is a change, and nothing else is (#1231).
describe('appendRatingChangeIfChanged (#1231)', () => {
  it.each([
    ['a new rating', 7, 6, 1],
    ['a cleared rating', null, 6, 1],
    ['the first rating of an entry with none', 7, null, 1],
    ['the same rating', 6, 6, 0],
    ['no rating on an entry with none', null, null, 0],
    ['no rating sent', undefined, 6, 0],
  ])('appends for %s: %s over %s', async (_, sent, current, appended) => {
    const create = jest.fn().mockResolvedValue({});

    await appendRatingChangeIfChanged(
      { collectionRatingChange: { create } } as never,
      'gc-1',
      sent,
      current,
      new Date(),
    );

    expect(create).toHaveBeenCalledTimes(appended);
  });
});

describe('CollectionRatingService (#1231)', () => {
  let service: CollectionRatingService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getActingUserId' | 'getCurrentResourceConditions'>>;

  beforeEach(async () => {
    abilityService = {
      getActingUserId: jest.fn().mockReturnValue(ME),
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [
        CollectionRatingService,
        // The REAL lock over the mocked database: every write takes the entry's row first (#1231).
        CollectionWriteService,
        { provide: AbilityService, useValue: abilityService },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    });

    db = ctx.db;
    unwrapTransaction(db);
    db.$queryRaw.mockResolvedValue([LOCKED] as never);
    db.gameCollection.update.mockResolvedValue({ id: 'gc-1' } as GameCollection);
    db.collectionRatingChange.findUnique.mockResolvedValue(changeRow() as never);
    db.collectionRatingChange.create.mockResolvedValue(changeRow() as never);
    db.collectionRatingChange.update.mockResolvedValue(changeRow() as never);
    db.collectionRatingRevision.findUnique.mockResolvedValue({ values: storedValues() } as never);
    service = ctx.module.get(CollectionRatingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Restores the Logger spies some specs make; the module mocks stay.
    jest.restoreAllMocks();
  });

  /**
   * Each write's first statement locks the entry's row, then holds the entry
   * to the actor's update conditions, as the copy routes do (#1231, #1288).
   * None of them runs the supply sync or writes the entry's own rating.
   */
  function expectLockedThenChecked(): void {
    const [lock] = db.$queryRaw.mock.calls[0] as unknown as [Prisma.Sql];
    expect(rawQueryText(lock)).toMatch(/FROM game_collections WHERE id = \? AND user_id = \? FOR UPDATE$/);
    expect(lock.values).toEqual(['gc-1', ME]);
    expect(db.gameCollection.update).toHaveBeenCalledTimes(1);
    expect(db.gameCollection.update).toHaveBeenCalledWith({
      where: { id: 'gc-1', AND: [COND] },
      data: { lastUpdated: expect.any(Date) },
      select: { id: true },
    });
    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
      ResourceType.GameCollection,
      Action.update,
    );
    expect(syncSupply).not.toHaveBeenCalled();
  }

  describe('list', () => {
    // The history is the entry owner's alone, whatever the entry's reach, so the
    // entry is read as the actor's own, under their read conditions. Unknown
    // dates come first, then the day the change was written, then the id, so
    // the order never moves between reads (#1231).
    it("reads the acting user's own entry under the read conditions, unknown dates first", async () => {
      db.gameCollection.findUnique.mockResolvedValue({
        ratingChanges: [
          {
            createdAt: new Date('2026-11-01T00:00:00Z'),
            id: 'rc-1',
            occurredOn: null,
            occurredOnPrecision: null,
            rating: 6,
            retractedAt: null,
          },
          {
            createdAt: new Date('2026-11-26T10:00:00Z'),
            id: 'rc-2',
            occurredOn: new Date('2026-11-26T00:00:00Z'),
            occurredOnPrecision: DatePrecision.Day,
            rating: null,
            retractedAt: new Date('2026-11-27T08:00:00Z'),
          },
        ],
      } as never);

      const changes = await service.list('gc-1');

      expect(db.gameCollection.findUnique).toHaveBeenCalledWith({
        where: { id: 'gc-1', userId: ME, AND: [COND] },
        select: {
          ratingChanges: {
            select: RATING_CHANGE_SELECT,
            orderBy: [{ occurredOn: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.read,
      );
      expect(changes).toEqual([
        { createdAt: new Date('2026-11-01T00:00:00Z'), id: 'rc-1', occurredOn: null, rating: 6, retractedAt: null },
        {
          createdAt: new Date('2026-11-26T10:00:00Z'),
          id: 'rc-2',
          occurredOn: '2026-11-26',
          rating: null,
          retractedAt: new Date('2026-11-27T08:00:00Z'),
        },
      ]);
    });

    it("answers COLLECTION_ENTRY_NOT_FOUND for an entry that isn't the actor's", async () => {
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.list('gc-1')).rejects.toMatchObject({ status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
    });

    // A plugin or system actor has no collection of its own (#1231).
    it('answers COLLECTION_ENTRY_NOT_FOUND to an actor that is no user, and reads nothing', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.list('gc-1')).rejects.toMatchObject({ status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
      expect(db.gameCollection.findUnique).not.toHaveBeenCalled();
    });
  });

  // A rating change's corrections never touch the entry's own rating, whatever
  // they write: correcting the history is not rating the game again (#1231).
  describe('add', () => {
    it("adds an earlier rating, stamped as the user's, without touching the entry's own rating (#1231)", async () => {
      const added = await service.add('gc-1', { occurredOn: '2018-06', rating: 9 });

      expectLockedThenChecked();
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionRatingChange.create).toHaveBeenCalledWith({
        data: {
          editedByUserAt: now,
          entryId: 'gc-1',
          occurredOn: new Date('2018-06-01T00:00:00Z'),
          occurredOnPrecision: DatePrecision.Month,
          rating: 9,
        },
        select: RATING_CHANGE_SELECT,
      });
      expect(db.gameCollection.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ rating: expect.anything() }) }),
      );
      expect(added).toMatchObject({ id: 'rc-1', rating: 7, occurredOn: '2019-03-02', retractedAt: null });
    });

    it('adds an earlier clearing of the rating, a change with no value', async () => {
      await service.add('gc-1', { occurredOn: '2018', rating: null });

      expect(db.collectionRatingChange.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ rating: null }) }),
      );
    });

    // R13: a date is in the future only when it is after today at UTC+14.
    it('accepts today where it is already the next day, and refuses a future date with COLLECTION_DATE_IN_FUTURE', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-26T23:30:00Z') });

      try {
        await expect(service.add('gc-1', { occurredOn: '2026-11-27', rating: 8 })).resolves.toBeDefined();
        await expect(service.add('gc-1', { occurredOn: '2026-11-28', rating: 8 })).rejects.toMatchObject({
          status: 400,
          code: 'COLLECTION_DATE_IN_FUTURE',
          response: expect.objectContaining({ field: 'occurredOn' }),
        });
        // The refusal comes before the lock: nothing was written for it.
        expect(db.collectionRatingChange.create).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("answers COLLECTION_ENTRY_NOT_FOUND for another user's entry, writing nothing", async () => {
      // The lock names the acting user, so it finds no row under another
      // user's entry id (#1231).
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.add('gc-1', { occurredOn: '2018', rating: 8 })).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
      expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
      expect(db.gameCollection.update).not.toHaveBeenCalled();
    });

    it("answers COLLECTION_ENTRY_NOT_FOUND for an entry outside the actor's update conditions", async () => {
      db.gameCollection.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Dependent record not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(service.add('gc-1', { occurredOn: '2018', rating: 8 })).rejects.toMatchObject({
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
      expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
    });
  });

  /**
   * #1231, ADR 0002. A client queues the add offline and may send it again,
   * so it carries a `clientRequestId`: a repeat answers the change the key
   * made, as it stands now, whatever the repeat says. The lookup runs under
   * the entry's lock, after the entry is found to be the actor's own and
   * within their update conditions, so a key is no way past those checks.
   */
  describe('add with a clientRequestId', () => {
    const KEY = 'key-1';
    const INDEX = 'collection_rating_change_entry_client_request_id_unique';
    const byKey = {
      where: { entryId_clientRequestId: { entryId: 'gc-1', clientRequestId: KEY } },
      select: RATING_CHANGE_SELECT,
    };

    beforeEach(() => {
      db.collectionRatingChange.findUnique.mockResolvedValue(null);
    });

    it('stores the key on the change it adds, after looking it up under the lock', async () => {
      await service.add('gc-1', { occurredOn: '2018', rating: 9, clientRequestId: ` ${KEY} ` });

      expectLockedThenChecked();
      expect(db.collectionRatingChange.findUnique).toHaveBeenCalledWith(byKey);
      expect(db.collectionRatingChange.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ clientRequestId: KEY, entryId: 'gc-1', rating: 9 }),
        select: RATING_CHANGE_SELECT,
      });
    });

    it('an add with no key looks nothing up', async () => {
      await service.add('gc-1', { occurredOn: '2018', rating: 9 });

      expect(db.collectionRatingChange.findUnique).not.toHaveBeenCalled();
    });

    // A repeat answers the original, taken back or corrected since included,
    // and writes nothing, whatever its own body says, a future date too.
    it('a repeat answers the change the key made, as it stands, and adds none, whatever its body says', async () => {
      db.collectionRatingChange.findUnique.mockResolvedValue(
        changeRow({ id: 'rc-2', rating: 4, retractedAt: new Date('2026-11-20T00:00:00Z') }) as never,
      );

      const replayed = await service.add('gc-1', { occurredOn: '2999', rating: 9, clientRequestId: KEY });

      expectLockedThenChecked();
      expect(replayed).toMatchObject({ id: 'rc-2', rating: 4, retractedAt: new Date('2026-11-20T00:00:00Z') });
      expect(db.collectionRatingChange.create).not.toHaveBeenCalled();
    });

    it("a repeat of another user's entry is still refused before the lookup", async () => {
      // The lock names the acting user, so it finds no row under another
      // user's entry id (#1231).
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.add('gc-1', { occurredOn: '2018', rating: 9, clientRequestId: KEY })).rejects.toMatchObject({
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
      expect(db.collectionRatingChange.findUnique).not.toHaveBeenCalled();
    });

    // Two repeats take the entry's lock in turn, so the second finds the
    // first's change. Should one still trip the key's unique, its transaction
    // is aborted, so the add runs once more and finds the change the other
    // committed.
    it("a concurrent repeat that trips the key's unique finds the other's change", async () => {
      db.collectionRatingChange.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(changeRow({ id: 'rc-other' }) as never);
      db.collectionRatingChange.create.mockRejectedValueOnce(uniqueViolation({ index: INDEX }));

      const added = await service.add('gc-1', { occurredOn: '2018', rating: 9, clientRequestId: KEY });

      expect(added).toMatchObject({ id: 'rc-other' });
      expect(db.$transaction).toHaveBeenCalledTimes(2);
      expect(db.collectionRatingChange.create).toHaveBeenCalledTimes(1);
      expect(db.collectionRatingChange.findUnique).toHaveBeenNthCalledWith(2, byKey);
    });

    it('rethrows a unique violation of an add with no key, and runs it once', async () => {
      const violation = uniqueViolation({ index: INDEX });
      db.collectionRatingChange.create.mockRejectedValue(violation);

      await expect(service.add('gc-1', { occurredOn: '2018', rating: 9 })).rejects.toBe(violation);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    it("rethrows a keyed add's violation of another unique, and runs it once", async () => {
      const violation = uniqueViolation({ index: 'collection_rating_changes_upstream_account_id_upstream_key_key' });
      db.collectionRatingChange.create.mockRejectedValue(violation);

      await expect(service.add('gc-1', { occurredOn: '2018', rating: 9, clientRequestId: KEY })).rejects.toBe(
        violation,
      );
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('keeps what the change said before as a revision, then writes the correction, stamped as edited by the user', async () => {
      const order: string[] = [];
      db.collectionRatingRevision.create.mockImplementation((async () => {
        order.push('revision');
        return { id: 'rev-1' };
      }) as never);
      db.collectionRatingChange.update.mockImplementation((async () => {
        order.push('write');
        return changeRow({ occurredOn: new Date('2019-01-01T00:00:00Z'), occurredOnPrecision: DatePrecision.Year });
      }) as never);

      const edited = await service.update('gc-1', 'rc-1', { occurredOn: '2019' });

      expectLockedThenChecked();
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      // A taken-back change never happened, so it takes no edit (#1231).
      expect(db.collectionRatingChange.findUnique).toHaveBeenCalledWith({
        where: { id: 'rc-1', entryId: 'gc-1', retractedAt: null },
        select: RATING_REVISION_SELECT,
      });
      expect(db.collectionRatingRevision.create).toHaveBeenCalledWith({
        data: { ratingChangeId: 'rc-1', values: ratingRevisionValues(changeRow()) },
        select: { id: true },
      });
      expect(db.collectionRatingChange.update).toHaveBeenCalledWith({
        where: { id: 'rc-1' },
        data: {
          editedByUserAt: now,
          occurredOn: new Date('2019-01-01T00:00:00Z'),
          occurredOnPrecision: DatePrecision.Year,
        },
        select: RATING_CHANGE_SELECT,
      });
      expect(order).toEqual(['revision', 'write']);
      expect(edited).toMatchObject({ id: 'rc-1', occurredOn: '2019' });
    });

    it('a null rating corrects the change into a clearing, and a null date makes it unknown', async () => {
      await service.update('gc-1', 'rc-1', { occurredOn: null, rating: null });

      expect(db.collectionRatingChange.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { editedByUserAt: expect.any(Date), occurredOn: null, occurredOnPrecision: null, rating: null },
        }),
      );
    });

    it('refuses an edit naming no field, before any lock', async () => {
      await expect(service.update('gc-1', 'rc-1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('refuses a future date with COLLECTION_DATE_IN_FUTURE', async () => {
      await expect(service.update('gc-1', 'rc-1', { occurredOn: '2999-01-01' })).rejects.toMatchObject({
        code: 'COLLECTION_DATE_IN_FUTURE',
      });
      expect(db.collectionRatingChange.update).not.toHaveBeenCalled();
    });

    // A change of another entry, or a taken-back one, is the same 404 as a missing one.
    it('answers COLLECTION_RATING_NOT_FOUND for a change the entry does not hold, or one taken back', async () => {
      db.collectionRatingChange.findUnique.mockResolvedValue(null);

      await expect(service.update('gc-1', 'rc-9', { rating: 3 })).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_RATING_NOT_FOUND',
      });
      expect(db.collectionRatingRevision.create).not.toHaveBeenCalled();
    });

    it("answers COLLECTION_ENTRY_NOT_FOUND for another user's entry before it reads the change", async () => {
      // The lock names the acting user, so it finds no row under another
      // user's entry id (#1231).
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.update('gc-1', 'rc-1', { rating: 3 })).rejects.toMatchObject({
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
      expect(db.collectionRatingChange.findUnique).not.toHaveBeenCalled();
    });
  });

  // A take-back changes none of the values a revision holds, so it writes no
  // revision: `retractedAt` and the stamp record it (#1231).
  describe('takeBack and undoTakeBack', () => {
    it('takes a change back and stamps it edited by the user, without a revision or the entry rating', async () => {
      db.collectionRatingChange.update.mockResolvedValue(changeRow({ retractedAt: new Date() }) as never);

      const taken = await service.takeBack('gc-1', 'rc-1');

      expectLockedThenChecked();
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionRatingChange.findUnique).toHaveBeenCalledWith({
        where: { id: 'rc-1', entryId: 'gc-1', retractedAt: null },
        select: RATING_REVISION_SELECT,
      });
      expect(db.collectionRatingRevision.create).not.toHaveBeenCalled();
      expect(db.collectionRatingChange.update).toHaveBeenCalledWith({
        where: { id: 'rc-1' },
        data: { editedByUserAt: now, retractedAt: now },
        select: RATING_CHANGE_SELECT,
      });
      expect(taken.retractedAt).toEqual(expect.any(Date));
    });

    it('any change can be taken back, the latest included: there is no last-rating rule', async () => {
      await service.takeBack('gc-1', 'rc-1');

      // Only the change's own row is read and written: no count of the others.
      expect(db.collectionRatingChange.count).not.toHaveBeenCalled();
    });

    it('answers COLLECTION_RATING_NOT_FOUND for a change missing or taken back already', async () => {
      db.collectionRatingChange.findUnique.mockResolvedValue(null);

      await expect(service.takeBack('gc-1', 'rc-1')).rejects.toMatchObject({ code: 'COLLECTION_RATING_NOT_FOUND' });
    });

    it('undoes a take-back and stamps the change edited by the user, without a revision', async () => {
      db.collectionRatingChange.findUnique.mockResolvedValue({ id: 'rc-1', retractedAt: new Date() } as never);

      await service.undoTakeBack('gc-1', 'rc-1');

      expectLockedThenChecked();
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionRatingChange.findUnique).toHaveBeenCalledWith({
        where: { id: 'rc-1', entryId: 'gc-1' },
        select: { id: true, retractedAt: true },
      });
      expect(db.collectionRatingRevision.create).not.toHaveBeenCalled();
      expect(db.collectionRatingChange.update).toHaveBeenCalledWith({
        where: { id: 'rc-1' },
        data: { editedByUserAt: now, retractedAt: null },
        select: RATING_CHANGE_SELECT,
      });
    });

    // A coded 404 reads as "this row is gone" (#634): a change that is live must not answer one.
    it('answers 409 COLLECTION_RATING_NOT_TAKEN_BACK to an undo of a change that exists but is not taken back', async () => {
      db.collectionRatingChange.findUnique.mockResolvedValue({ id: 'rc-1', retractedAt: null } as never);

      await expect(service.undoTakeBack('gc-1', 'rc-1')).rejects.toMatchObject({
        status: 409,
        code: 'COLLECTION_RATING_NOT_TAKEN_BACK',
      });
      expect(db.collectionRatingChange.update).not.toHaveBeenCalled();
    });

    it('answers COLLECTION_RATING_NOT_FOUND to an undo of a change the entry does not hold', async () => {
      db.collectionRatingChange.findUnique.mockResolvedValue(null);

      await expect(service.undoTakeBack('gc-1', 'rc-1')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_RATING_NOT_FOUND',
      });
    });
  });

  describe('listRevisions', () => {
    it("reads the acting user's own entry, newest revision first, in the shape its owner reads the change", async () => {
      db.gameCollection.findUnique.mockResolvedValue({
        ratingChanges: [
          {
            revisions: [
              { createdAt: new Date('2026-11-27T00:00:00Z'), id: 'rev-2', values: storedValues({ rating: null }) },
              { createdAt: new Date('2026-11-26T00:00:00Z'), id: 'rev-1', values: storedValues() },
            ],
          },
        ],
      } as never);

      const revisions = await service.listRevisions('gc-1', 'rc-1');

      expect(db.gameCollection.findUnique).toHaveBeenCalledWith({
        where: { id: 'gc-1', userId: ME, AND: [COND] },
        select: {
          ratingChanges: {
            where: { id: 'rc-1' },
            select: {
              revisions: {
                select: { createdAt: true, id: true, values: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              },
            },
          },
        },
      });
      expect(revisions).toEqual([
        { createdAt: new Date('2026-11-27T00:00:00Z'), id: 'rev-2', values: { occurredOn: '2018', rating: null } },
        { createdAt: new Date('2026-11-26T00:00:00Z'), id: 'rev-1', values: { occurredOn: '2018', rating: 5 } },
      ]);
    });

    it('leaves out a revision whose values fail the schema, and logs one line saying why', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      db.gameCollection.findUnique.mockResolvedValue({
        ratingChanges: [
          {
            revisions: [
              {
                createdAt: new Date(),
                id: 'rev-bad',
                values: { rating: 11, occurredOn: null, occurredOnPrecision: null },
              },
              { createdAt: new Date(), id: 'rev-ok', values: storedValues() },
            ],
          },
        ],
      } as never);

      const revisions = await service.listRevisions('gc-1', 'rc-1');

      expect(revisions.map(({ id }) => id)).toEqual(['rev-ok']);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('rev-bad'));
    });

    it('answers COLLECTION_RATING_NOT_FOUND for a change the entry does not hold', async () => {
      db.gameCollection.findUnique.mockResolvedValue({ ratingChanges: [] } as never);

      await expect(service.listRevisions('gc-1', 'rc-9')).rejects.toMatchObject({
        code: 'COLLECTION_RATING_NOT_FOUND',
      });
    });

    it("answers COLLECTION_ENTRY_NOT_FOUND for an entry that isn't the actor's", async () => {
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.listRevisions('gc-1', 'rc-1')).rejects.toMatchObject({
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
    });
  });

  describe('restore', () => {
    it('restoring a revision of a rating change records the current values as a revision first, then writes the old ones', async () => {
      const order: string[] = [];
      db.collectionRatingRevision.create.mockImplementation((async () => {
        order.push('revision');
        return { id: 'rev-new' };
      }) as never);
      db.collectionRatingChange.update.mockImplementation((async () => {
        order.push('write');
        return changeRow({ rating: 5 });
      }) as never);

      const restored = await service.restore('gc-1', 'rc-1', 'rev-1');

      expectLockedThenChecked();
      const now = db.gameCollection.update.mock.calls[0]?.[0]?.data.lastUpdated;
      expect(db.collectionRatingRevision.findUnique).toHaveBeenCalledWith({
        where: { id: 'rev-1', ratingChangeId: 'rc-1' },
        select: { values: true },
      });
      // What the change says now is kept, so the restore can be undone the same way.
      expect(db.collectionRatingRevision.create).toHaveBeenCalledWith({
        data: { ratingChangeId: 'rc-1', values: ratingRevisionValues(changeRow()) },
        select: { id: true },
      });
      expect(db.collectionRatingChange.update).toHaveBeenCalledWith({
        where: { id: 'rc-1' },
        data: {
          editedByUserAt: now,
          occurredOn: new Date('2018-01-01T00:00:00Z'),
          occurredOnPrecision: DatePrecision.Year,
          rating: 5,
        },
        select: RATING_CHANGE_SELECT,
      });
      expect(order).toEqual(['revision', 'write']);
      expect(restored).toMatchObject({ id: 'rc-1', rating: 5 });
    });

    it('answers COLLECTION_RATING_NOT_FOUND for a change that is taken back, before it reads the revision', async () => {
      db.collectionRatingChange.findUnique.mockResolvedValue(null);

      await expect(service.restore('gc-1', 'rc-1', 'rev-1')).rejects.toMatchObject({
        code: 'COLLECTION_RATING_NOT_FOUND',
      });
      expect(db.collectionRatingRevision.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['a revision the change does not hold', null],
      ['stored values that fail the schema', { values: { rating: 99, occurredOn: null, occurredOnPrecision: null } }],
    ])('answers COLLECTION_REVISION_NOT_FOUND for %s', async (_, found) => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      db.collectionRatingRevision.findUnique.mockResolvedValue(found as never);

      await expect(service.restore('gc-1', 'rc-1', 'rev-1')).rejects.toMatchObject({
        status: 404,
        code: 'COLLECTION_REVISION_NOT_FOUND',
      });
      expect(db.collectionRatingChange.update).not.toHaveBeenCalled();
    });

    it("answers COLLECTION_ENTRY_NOT_FOUND for another user's entry", async () => {
      // The lock names the acting user, so it finds no row under another
      // user's entry id (#1231).
      db.$queryRaw.mockResolvedValue([] as never);

      await expect(service.restore('gc-1', 'rc-1', 'rev-1')).rejects.toMatchObject({
        code: 'COLLECTION_ENTRY_NOT_FOUND',
      });
    });
  });
});
