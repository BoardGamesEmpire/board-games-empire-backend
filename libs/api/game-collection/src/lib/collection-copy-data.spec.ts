import type { GameRelease, Prisma } from '@bge/database';
import { DatePrecision, GameCondition, GameMedium } from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { assertCopyRoom, COLLECTION_COPY_LIMIT, copyCreateData } from './collection-copy-data';

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

/** 2026-11-26 at noon UTC: "today" for every date below (#1231). */
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

  it.each(['2026-11-27', '2026-12', '2027'])(
    'refuses the acquisition %s, after today, with COLLECTION_DATE_IN_FUTURE',
    async (acquiredOn) => {
      await expect(copyCreateData(asTx(tx), { acquiredOn }, PHYSICAL, NOW)).rejects.toMatchObject({
        status: 400,
        code: 'COLLECTION_DATE_IN_FUTURE',
      });
    },
  );

  // The year and month that have begun are not in the future (#1231).
  it.each(['2026-11-26', '2026-11', '2026'])('takes the acquisition %s, which has begun', async (acquiredOn) => {
    await expect(copyCreateData(asTx(tx), { acquiredOn }, PHYSICAL, NOW)).resolves.toMatchObject({
      acquiredOn: expect.any(Date),
    });
  });

  it.each([
    ['price paid', { pricePaid: { amount: 100, currency: 'XYZ' } }],
    ['current value', { currentValue: { amount: 100, currency: 'XYZ' } }],
  ])('refuses an unknown currency in the %s with COLLECTION_CURRENCY_UNKNOWN', async (_, dto) => {
    await expect(copyCreateData(asTx(tx), dto, PHYSICAL, NOW)).rejects.toMatchObject({
      status: 400,
      code: 'COLLECTION_CURRENCY_UNKNOWN',
    });
  });

  // The release refusals keep the exceptions they had on the entry, without
  // a code of their own.
  it("refuses a release of another platform game, with the entry's platform game named", async () => {
    tx.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-2' } as GameRelease);

    await expect(copyCreateData(asTx(tx), { releaseId: 'rel-2' }, PHYSICAL, NOW)).rejects.toThrow(BadRequestException);
    expect(tx.gameRelease.findUnique).toHaveBeenCalledWith({
      where: { id: 'rel-2' },
      select: { platformGameId: true },
    });
  });

  it('refuses a release that does not exist', async () => {
    tx.gameRelease.findUnique.mockResolvedValue(null);

    await expect(copyCreateData(asTx(tx), { releaseId: 'rel-404' }, PHYSICAL, NOW)).rejects.toThrow(NotFoundException);
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

  // Removed and taken-back copies count too, so an entry's history stays
  // bounded: the count has no state filter.
  it("counts every one of the entry's copies, whatever its state", async () => {
    tx.collectionCopy.count.mockResolvedValue(99);

    await expect(assertCopyRoom(asTx(tx), 'gc-1')).resolves.toBeUndefined();
    expect(tx.collectionCopy.count).toHaveBeenCalledWith({ where: { entryId: 'gc-1' } });
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
