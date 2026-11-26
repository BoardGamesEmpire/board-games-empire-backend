import type { Prisma } from '@bge/database';
import { DatePrecision, GameCondition, GameRemovalReason } from '@bge/database';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import type { CopyRevisionSource, CopyRevisionValues } from './collection-revisions';
import {
  copyRevisionValues,
  copyRevisionValuesSchema,
  describeRevisionProblem,
  recordCopyRevision,
  recordCopyRevisions,
  restoredCopyOf,
} from './collection-revisions';

const asTx = (mock: MockDatabaseService): Prisma.TransactionClient => mock as unknown as Prisma.TransactionClient;

/** A copy's revision columns: nothing known, unless given (#1231). */
const source = (overrides: Partial<CopyRevisionSource> = {}): CopyRevisionSource => ({
  id: 'copy-1',
  releaseId: null,
  condition: null,
  acquiredOn: null,
  acquiredOnPrecision: null,
  acquiredFrom: null,
  pricePaidAmount: null,
  pricePaidCurrency: null,
  currentValueAmount: null,
  currentValueCurrency: null,
  note: null,
  removedAt: null,
  removedOn: null,
  removedOnPrecision: null,
  removeReason: null,
  ...overrides,
});

/** A removed copy that says everything a copy can (#1231). */
const FULL = source({
  releaseId: 'rel-1',
  condition: GameCondition.LikeNew,
  acquiredOn: new Date('2019-03-01T00:00:00Z'),
  acquiredOnPrecision: DatePrecision.Month,
  acquiredFrom: 'A friend',
  pricePaidAmount: 2500,
  pricePaidCurrency: 'USD',
  currentValueAmount: 4000,
  currentValueCurrency: 'EUR',
  note: 'The **deluxe** one',
  removedAt: new Date('2024-07-01T10:20:30.456Z'),
  removedOn: new Date('2024-01-01T00:00:00Z'),
  removedOnPrecision: DatePrecision.Year,
  removeReason: GameRemovalReason.Sold,
});

describe('copy revisions (#1231)', () => {
  describe('copyRevisionValues', () => {
    it('keeps every editable column, dates as ISO days and the removal as an ISO timestamp', () => {
      expect(copyRevisionValues(FULL)).toEqual({
        releaseId: 'rel-1',
        condition: GameCondition.LikeNew,
        acquiredOn: '2019-03-01',
        acquiredOnPrecision: DatePrecision.Month,
        acquiredFrom: 'A friend',
        pricePaidAmount: 2500,
        pricePaidCurrency: 'USD',
        currentValueAmount: 4000,
        currentValueCurrency: 'EUR',
        note: 'The **deluxe** one',
        removedAt: '2024-07-01T10:20:30.456Z',
        removedOn: '2024-01-01',
        removedOnPrecision: DatePrecision.Year,
        removeReason: GameRemovalReason.Sold,
      });
    });

    // The copy's own id is the revision's `copyId`, not one of its values.
    it('keeps no id', () => {
      expect(copyRevisionValues(FULL)).not.toHaveProperty('id');
    });

    it('reads back through its own schema', () => {
      const stored = JSON.parse(JSON.stringify(copyRevisionValues(FULL)));

      expect(copyRevisionValuesSchema.safeParse(stored)).toEqual({ success: true, data: copyRevisionValues(FULL) });
      expect(copyRevisionValuesSchema.safeParse(copyRevisionValues(source())).success).toBe(true);
    });
  });

  describe('copyRevisionValuesSchema', () => {
    const valid = copyRevisionValues(FULL);

    // The values are read back from a JSON column, data from outside the
    // process: what the copy's CHECK constraints would refuse is refused here,
    // so a restore never fails on one (#1231).
    it.each<[string, Partial<Record<keyof CopyRevisionValues, unknown>>]>([
      ['an amount without its currency', { pricePaidCurrency: null }],
      ['a currency without its amount', { currentValueAmount: null }],
      ['a negative amount', { pricePaidAmount: -1 }],
      ['an amount past the column', { pricePaidAmount: 2147483648 }],
      ['a fractional amount', { pricePaidAmount: 1.5 }],
      ['a currency that is not three capitals', { pricePaidCurrency: 'usd' }],
      ['a date without its precision', { acquiredOnPrecision: null }],
      ['a precision without its date', { removedOn: null }],
      ['a date that is not an ISO day', { acquiredOn: '2019-03' }],
      ['an unknown precision', { removedOnPrecision: 'Week' }],
      ['an unknown condition', { condition: 'Shiny' }],
      ['a removal date without a removal', { removedAt: null, removeReason: null }],
      ['a removal reason without a removal', { removedAt: null, removedOn: null, removedOnPrecision: null }],
      ['a removal stamp that is not a timestamp', { removedAt: 'yesterday' }],
      ['a missing column', { note: undefined }],
    ])('refuses %s', (_, change) => {
      expect(copyRevisionValuesSchema.safeParse({ ...valid, ...change }).success).toBe(false);
    });

    it('refuses what is not an object', () => {
      expect(copyRevisionValuesSchema.safeParse('values').success).toBe(false);
      expect(copyRevisionValuesSchema.safeParse(null).success).toBe(false);
    });
  });

  describe('describeRevisionProblem', () => {
    // nestjs-pino drops an Error argument, so the problem is logged as one
    // line of text (#1231).
    it('names each failing path on one line', () => {
      const parsed = copyRevisionValuesSchema.safeParse({ ...copyRevisionValues(FULL), note: 7, condition: 'Shiny' });

      if (parsed.success) {
        throw new Error('the values were meant to fail the schema');
      }

      const described = describeRevisionProblem(parsed.error);
      expect(described).not.toContain('\n');
      expect(described).toContain('note');
      expect(described).toContain('condition');
    });
  });

  describe('recordCopyRevision', () => {
    it("writes the copy's values as a revision of it", async () => {
      const tx = createMockDatabaseService();

      await recordCopyRevision(asTx(tx), FULL);

      expect(tx.collectionCopyRevision.createMany).toHaveBeenCalledWith({
        data: [{ copyId: 'copy-1', values: copyRevisionValues(FULL) }],
      });
    });

    it('writes one revision per copy, in one statement', async () => {
      const tx = createMockDatabaseService();

      await recordCopyRevisions(asTx(tx), [FULL, source({ id: 'copy-2', note: 'Sleeved' })]);

      expect(tx.collectionCopyRevision.createMany).toHaveBeenCalledTimes(1);
      expect(tx.collectionCopyRevision.createMany).toHaveBeenCalledWith({
        data: [
          { copyId: 'copy-1', values: copyRevisionValues(FULL) },
          { copyId: 'copy-2', values: expect.objectContaining({ note: 'Sleeved' }) },
        ],
      });
    });

    it('writes nothing for no copies', async () => {
      const tx = createMockDatabaseService();

      await recordCopyRevisions(asTx(tx), []);

      expect(tx.collectionCopyRevision.createMany).not.toHaveBeenCalled();
    });
  });

  describe('restoredCopyOf', () => {
    it('describes the copy as a user would send it, and its removal as stored', () => {
      expect(restoredCopyOf(copyRevisionValues(FULL))).toEqual({
        description: {
          acquiredFrom: 'A friend',
          acquiredOn: '2019-03',
          condition: GameCondition.LikeNew,
          currentValue: { amount: 4000, currency: 'EUR' },
          note: 'The **deluxe** one',
          pricePaid: { amount: 2500, currency: 'USD' },
        },
        removal: {
          removedAt: new Date('2024-07-01T10:20:30.456Z'),
          removedOn: { on: new Date('2024-01-01T00:00:00Z'), precision: DatePrecision.Year },
          removeReason: GameRemovalReason.Sold,
        },
      });
    });

    it('restores an owned copy as unknown wherever it said nothing', () => {
      expect(restoredCopyOf(copyRevisionValues(source()))).toEqual({
        description: {
          acquiredFrom: null,
          acquiredOn: null,
          condition: null,
          currentValue: null,
          note: null,
          pricePaid: null,
        },
        removal: { removedAt: null, removedOn: null, removeReason: null },
      });
    });

    // The column holds the first day of the period; a stored day inside one
    // is read at its precision, so the restore writes the period's start.
    it('reads a stored date at its precision', () => {
      const values = {
        ...copyRevisionValues(source()),
        acquiredOn: '2019-03-15',
        acquiredOnPrecision: DatePrecision.Year,
      };

      expect(restoredCopyOf(values).description.acquiredOn).toBe('2019');
    });
  });
});
