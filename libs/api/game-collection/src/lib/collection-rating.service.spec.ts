import { Action, DatePrecision, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb } from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import {
  appendRatingChange,
  appendRatingChangeIfChanged,
  CollectionRatingService,
  RATING_CHANGE_SELECT,
} from './collection-rating.service';

const COND = { id: 'sentinel-condition' };
const ME = 'user-1';

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
      providers: [CollectionRatingService, { provide: AbilityService, useValue: abilityService }],
    });

    db = ctx.db;
    service = ctx.module.get(CollectionRatingService);
  });

  afterEach(() => jest.clearAllMocks());

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
          },
          {
            createdAt: new Date('2026-11-26T10:00:00Z'),
            id: 'rc-2',
            occurredOn: new Date('2026-11-26T00:00:00Z'),
            occurredOnPrecision: DatePrecision.Day,
            rating: null,
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
        { createdAt: new Date('2026-11-01T00:00:00Z'), id: 'rc-1', occurredOn: null, rating: 6 },
        { createdAt: new Date('2026-11-26T10:00:00Z'), id: 'rc-2', occurredOn: '2026-11-26', rating: null },
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
});
