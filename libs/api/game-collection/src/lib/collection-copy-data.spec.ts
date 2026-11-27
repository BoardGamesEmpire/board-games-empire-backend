import type { GameRelease, Prisma } from '@bge/database';
import { DatePrecision, GameCondition, GameMedium, GameRemovalReason } from '@bge/database';
import { foreignKeyViolation, uniqueViolation } from '@bge/database/testing';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import {
  addCopy,
  assertCopyRoom,
  assertRemovableOn,
  COLLECTION_COPY_LIMIT,
  copyColumns,
  copyCreateData,
  copyRemovalData,
  writingRelease,
} from './collection-copy-data';
import { OWNER_COPY_SELECT } from './collection-row';
import { parsePartialDate } from './values/partial-date';

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

/**
 * 2026-11-26 at noon UTC: "today" for every date below (#1231). At UTC+14 it
 * is already 02:00 on the 27th, so the 27th is today somewhere, and the 28th
 * is the first day in the future.
 */
const NOW = new Date('2026-11-26T12:00:00Z');

const PHYSICAL = { medium: GameMedium.Physical, platformGameId: 'pg-1' };
const DIGITAL = { medium: GameMedium.Digital, platformGameId: 'pg-1' };

/** Nothing known about the copy: what an add with no `copy` records (#1231). */
const UNKNOWN = {
  acquiredFrom: null,
  acquiredOn: null,
  acquiredOnPrecision: null,
  condition: null,
  currentValueAmount: null,
  currentValueCurrency: null,
  note: null,
  pricePaidAmount: null,
  pricePaidCurrency: null,
  releaseId: null,
};

describe('copyCreateData (#1231)', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
    tx.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameRelease);
  });

  it('maps each field to its columns: the date at its precision, each price as amount and currency', async () => {
    await expect(
      copyCreateData(
        asTx(tx),
        {
          releaseId: 'rel-1',
          condition: GameCondition.Good,
          acquiredOn: '2019-03',
          acquiredFrom: 'A shop on the corner',
          pricePaid: { amount: 1250, currency: 'EUR' },
          currentValue: { amount: 3000, currency: 'JPY' },
          note: 'Signed by the **designer**',
        },
        PHYSICAL,
        NOW,
      ),
    ).resolves.toEqual({
      acquiredFrom: 'A shop on the corner',
      acquiredOn: new Date('2019-03-01T00:00:00Z'),
      acquiredOnPrecision: DatePrecision.Month,
      condition: GameCondition.Good,
      currentValueAmount: 3000,
      currentValueCurrency: 'JPY',
      note: 'Signed by the **designer**',
      pricePaidAmount: 1250,
      pricePaidCurrency: 'EUR',
      releaseId: 'rel-1',
    });
  });

  // A user who says nothing about the copy gets an unknown acquisition date,
  // never an invented one, and no release is looked up.
  it('records nothing known for an empty copy, and reads no release', async () => {
    await expect(copyCreateData(asTx(tx), {}, PHYSICAL, NOW)).resolves.toEqual(UNKNOWN);
    expect(tx.gameRelease.findUnique).not.toHaveBeenCalled();
  });

  it('reads null fields as unknown', async () => {
    await expect(
      copyCreateData(
        asTx(tx),
        // A client may send null for a field it has nothing for; the
        // validation pipe lets null through an optional field.
        { releaseId: null, condition: null, acquiredOn: null, pricePaid: null } as never,
        PHYSICAL,
        NOW,
      ),
    ).resolves.toEqual(UNKNOWN);
  });

  it('refuses a condition on a digital copy with COLLECTION_CONDITION_DIGITAL', async () => {
    await expect(copyCreateData(asTx(tx), { condition: GameCondition.New }, DIGITAL, NOW)).rejects.toMatchObject({
      status: 400,
      code: 'COLLECTION_CONDITION_DIGITAL',
    });
  });

  it('takes a digital copy with no condition', async () => {
    await expect(copyCreateData(asTx(tx), { acquiredOn: '2020' }, DIGITAL, NOW)).resolves.toMatchObject({
      condition: null,
      acquiredOnPrecision: DatePrecision.Year,
    });
  });

  it.each(['2026-11-28', '2026-12', '2027'])(
    'refuses the acquisition %s, today nowhere yet, with COLLECTION_DATE_IN_FUTURE naming acquiredOn',
    async (acquiredOn) => {
      await expect(copyCreateData(asTx(tx), { acquiredOn }, PHYSICAL, NOW)).rejects.toMatchObject({
        status: 400,
        code: 'COLLECTION_DATE_IN_FUTURE',
        response: expect.objectContaining({ field: 'acquiredOn' }),
      });
    },
  );

  // The year and month that have begun are not in the future, and neither is
  // a day that is today somewhere on Earth (#1231).
  it.each(['2026-11-27', '2026-11-26', '2026-11', '2026'])(
    'takes the acquisition %s, which has begun',
    async (acquiredOn) => {
      await expect(copyCreateData(asTx(tx), { acquiredOn }, PHYSICAL, NOW)).resolves.toMatchObject({
        acquiredOn: expect.any(Date),
      });
    },
  );

  it.each([
    ['price paid', { pricePaid: { amount: 100, currency: 'XYZ' } }],
    ['current value', { currentValue: { amount: 100, currency: 'XYZ' } }],
  ])('refuses an unknown currency in the %s with COLLECTION_CURRENCY_UNKNOWN', async (_, dto) => {
    await expect(copyCreateData(asTx(tx), dto, PHYSICAL, NOW)).rejects.toMatchObject({
      status: 400,
      code: 'COLLECTION_CURRENCY_UNKNOWN',
    });
  });

  // Each release refusal carries a stable code (#1231).
  it('refuses a release of another platform game with COLLECTION_RELEASE_PLATFORM_MISMATCH', async () => {
    tx.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-2' } as GameRelease);

    await expect(copyCreateData(asTx(tx), { releaseId: 'rel-2' }, PHYSICAL, NOW)).rejects.toMatchObject({
      status: 400,
      code: 'COLLECTION_RELEASE_PLATFORM_MISMATCH',
    });
    expect(tx.gameRelease.findUnique).toHaveBeenCalledWith({
      where: { id: 'rel-2' },
      select: { platformGameId: true },
    });
  });

  it('refuses a release that does not exist with GAME_RELEASE_NOT_FOUND', async () => {
    tx.gameRelease.findUnique.mockResolvedValue(null);

    await expect(copyCreateData(asTx(tx), { releaseId: 'rel-404' }, PHYSICAL, NOW)).rejects.toMatchObject({
      status: 404,
      code: 'GAME_RELEASE_NOT_FOUND',
    });
  });
});

// An edit of a copy writes only what it names, under the same refusals as
// an add (#1231).
describe('copyColumns (#1231)', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
    tx.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameRelease);
  });

  it('writes only the fields given, so an edit leaves the rest as they are', async () => {
    await expect(copyColumns(asTx(tx), { note: 'Sleeved', acquiredOn: '2019' }, PHYSICAL, NOW)).resolves.toEqual({
      acquiredOn: new Date('2019-01-01T00:00:00Z'),
      acquiredOnPrecision: DatePrecision.Year,
      note: 'Sleeved',
    });
  });

  it('clears each field sent as null, a price by both its columns, and reads no release', async () => {
    await expect(
      copyColumns(
        asTx(tx),
        { releaseId: null, condition: null, acquiredOn: null, pricePaid: null, acquiredFrom: null },
        PHYSICAL,
        NOW,
      ),
    ).resolves.toEqual({
      acquiredFrom: null,
      acquiredOn: null,
      acquiredOnPrecision: null,
      condition: null,
      pricePaidAmount: null,
      pricePaidCurrency: null,
      releaseId: null,
    });
    expect(tx.gameRelease.findUnique).not.toHaveBeenCalled();
  });

  it('writes nothing for an empty edit', async () => {
    await expect(copyColumns(asTx(tx), {}, PHYSICAL, NOW)).resolves.toEqual({});
  });

  it('refuses a condition on a digital copy, and takes clearing it', async () => {
    await expect(copyColumns(asTx(tx), { condition: GameCondition.Good }, DIGITAL, NOW)).rejects.toMatchObject({
      code: 'COLLECTION_CONDITION_DIGITAL',
    });
    await expect(copyColumns(asTx(tx), { condition: null }, DIGITAL, NOW)).resolves.toEqual({ condition: null });
  });

  it('refuses an acquisition today nowhere yet, and an unknown currency', async () => {
    await expect(copyColumns(asTx(tx), { acquiredOn: '2026-11-28' }, PHYSICAL, NOW)).rejects.toMatchObject({
      code: 'COLLECTION_DATE_IN_FUTURE',
    });
    await expect(
      copyColumns(asTx(tx), { currentValue: { amount: 1, currency: 'XYZ' } }, PHYSICAL, NOW),
    ).rejects.toMatchObject({ code: 'COLLECTION_CURRENCY_UNKNOWN' });
  });

  it('refuses a release of another platform game', async () => {
    tx.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-2' } as GameRelease);

    await expect(copyColumns(asTx(tx), { releaseId: 'rel-2' }, PHYSICAL, NOW)).rejects.toMatchObject({
      code: 'COLLECTION_RELEASE_PLATFORM_MISMATCH',
    });
  });
});

describe('assertCopyRoom (#1231)', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
  });

  it('holds 100 copies', () => {
    expect(COLLECTION_COPY_LIMIT).toBe(100);
  });

  // Removed and taken-back copies don't count: each removal and acquisition
  // again adds a copy, and no route deletes one, so counting them would one
  // day refuse the game for good.
  it("counts only the entry's copies the user owns", async () => {
    tx.collectionCopy.count.mockResolvedValue(99);

    await expect(assertCopyRoom(asTx(tx), 'gc-1')).resolves.toBeUndefined();
    expect(tx.collectionCopy.count).toHaveBeenCalledWith({
      where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
    });
  });

  it('refuses a copy past the limit with COLLECTION_COPY_LIMIT_REACHED, naming the limit', async () => {
    tx.collectionCopy.count.mockResolvedValue(100);

    await expect(assertCopyRoom(asTx(tx), 'gc-1')).rejects.toMatchObject({
      status: 409,
      code: 'COLLECTION_COPY_LIMIT_REACHED',
      response: expect.objectContaining({ limit: 100 }),
    });
  });
});

// One add of a copy to an entry that exists, for the copy route and the add
// that acquires a removed entry again (#1231).
describe('addCopy (#1231)', () => {
  let tx: MockDatabaseService;

  beforeEach(() => {
    tx = createMockDatabaseService();
    tx.collectionCopy.count.mockResolvedValue(1);
    tx.collectionCopy.create.mockResolvedValue({ id: 'copy-2' } as never);
    tx.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameRelease);
  });

  it("checks the room, then writes the described copy as the entry's owner reads it, keyed when a key is given", async () => {
    await addCopy(asTx(tx), { ...PHYSICAL, id: 'gc-1' }, { note: 'Deluxe' }, NOW, 'key-1');

    expect(tx.collectionCopy.count).toHaveBeenCalledWith({
      where: { entryId: 'gc-1', removedAt: null, retractedAt: null },
    });
    expect(tx.collectionCopy.create).toHaveBeenCalledWith({
      data: { entryId: 'gc-1', ...UNKNOWN, note: 'Deluxe', clientRequestId: 'key-1' },
      select: OWNER_COPY_SELECT,
    });
  });

  it('writes no key when none is given', async () => {
    await addCopy(asTx(tx), { ...PHYSICAL, id: 'gc-1' }, {}, NOW);

    expect(tx.collectionCopy.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('clientRequestId');
  });

  // The cap is checked before the copy is described, so a full entry is
  // refused before its release is read.
  it('refuses a full entry before reading the release, and writes nothing', async () => {
    tx.collectionCopy.count.mockResolvedValue(COLLECTION_COPY_LIMIT);

    await expect(addCopy(asTx(tx), { ...PHYSICAL, id: 'gc-1' }, { releaseId: 'rel-1' }, NOW)).rejects.toMatchObject({
      code: 'COLLECTION_COPY_LIMIT_REACHED',
    });
    expect(tx.gameRelease.findUnique).not.toHaveBeenCalled();
    expect(tx.collectionCopy.create).not.toHaveBeenCalled();
  });

  // The release was read without a lock, so it can go before the insert; its
  // trigger then fails the copy, which answers the 404 of a release never
  // there, not a 500.
  it('answers GAME_RELEASE_NOT_FOUND for a release gone before the insert', async () => {
    tx.collectionCopy.create.mockRejectedValue(foreignKeyViolation({ index: 'collection_copies_release_match' }));

    await expect(addCopy(asTx(tx), { ...PHYSICAL, id: 'gc-1' }, { releaseId: 'rel-1' }, NOW)).rejects.toMatchObject({
      status: 404,
      code: 'GAME_RELEASE_NOT_FOUND',
    });
  });
});

describe('writingRelease (#1231)', () => {
  it.each([
    ['its trigger', foreignKeyViolation({ index: 'collection_copies_release_match' })],
    ['its foreign key', foreignKeyViolation({ index: 'collection_copies_release_id_fkey' })],
    ['its column', foreignKeyViolation({ fields: ['release_id'] })],
    // A copy written under its entry's lock has no other reference that can go.
    ['no constraint at all', foreignKeyViolation({ omitConstraint: true })],
  ])('maps a release failure named by %s to GAME_RELEASE_NOT_FOUND', async (_, failure) => {
    await expect(writingRelease('rel-1', () => Promise.reject(failure))).rejects.toMatchObject({
      status: 404,
      code: 'GAME_RELEASE_NOT_FOUND',
    });
  });

  it.each([
    ['a write that sets no release', undefined, foreignKeyViolation({ omitConstraint: true })],
    ['a write that clears the release', null, foreignKeyViolation({ omitConstraint: true })],
    ['another foreign key', 'rel-1', foreignKeyViolation({ index: 'collection_copies_entry_id_fkey' })],
    ['a unique violation', 'rel-1', uniqueViolation()],
  ])('rethrows the failure of %s as it is', async (_, releaseId, failure) => {
    await expect(writingRelease(releaseId, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it("answers the write's own answer when it succeeds", async () => {
    await expect(writingRelease('rel-1', async () => 'written')).resolves.toBe('written');
  });
});

// Every removal of a copy, one copy or the whole entry, writes the same
// columns and makes the same check (#1231).
describe('copyRemovalData and assertRemovableOn (#1231)', () => {
  const removal = parsePartialDate('2024-06');

  it('records when, the date at its precision, the reason, and stamps the copy as edited by the user', () => {
    if (removal === null) {
      throw new Error('2024-06 is a partial date');
    }

    expect(copyRemovalData(removal, GameRemovalReason.Sold, NOW)).toEqual({
      removedAt: NOW,
      removedOn: new Date('2024-06-01T00:00:00Z'),
      removedOnPrecision: DatePrecision.Month,
      removeReason: GameRemovalReason.Sold,
      editedByUserAt: NOW,
    });
    expect(copyRemovalData(removal, undefined, NOW)).toMatchObject({ removeReason: null });
  });

  it('refuses a removal that ends before the acquisition with COLLECTION_DATE_ORDER', () => {
    if (removal === null) {
      throw new Error('2024-06 is a partial date');
    }

    const acquired = { acquiredOn: new Date('2024-07-01T00:00:00Z'), acquiredOnPrecision: DatePrecision.Month };

    expect(() => assertRemovableOn(acquired, removal)).toThrow(
      expect.objectContaining({ code: 'COLLECTION_DATE_ORDER' }),
    );
    expect(() => assertRemovableOn({ acquiredOn: null, acquiredOnPrecision: null }, removal)).not.toThrow();
  });
});
