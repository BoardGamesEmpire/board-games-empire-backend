import { DatePrecision } from '@bge/database';
import type { PartialDate } from './partial-date';
import {
  assertNotInFuture,
  assertRemovalAfterAcquisition,
  defaultRemovalDate,
  formatPartialDate,
  lastDayOf,
  latestToday,
  parsePartialDate,
  partialDateFromColumns,
  sentDate,
  todayUtc,
} from './partial-date';

/** The refusal `fn` throws, so a spec can match its status and code. */
function refusal(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }

  return undefined;
}

/** Parses a literal the spec knows is well formed. */
function dateOf(text: string): PartialDate {
  const parsed = parsePartialDate(text);

  if (parsed === null) {
    throw new Error(`${text} is not a partial date`);
  }

  return parsed;
}

const DATE_IN_FUTURE = { status: 400, code: 'COLLECTION_DATE_IN_FUTURE' };

/** The refusal's envelope fields, where it names the date it refused (#1231). */
const fieldsOf = (error: unknown) => (error as { getResponse(): Record<string, unknown> }).getResponse();
const DATE_ORDER = { status: 400, code: 'COLLECTION_DATE_ORDER' };

// A copy's acquisition and removal dates are as exact as the user knows them:
// a year, a month or a day (#1231).
describe('parsePartialDate (#1231)', () => {
  it('reads a year as its first day', () => {
    expect(parsePartialDate('2019')).toEqual({ on: new Date('2019-01-01T00:00:00Z'), precision: DatePrecision.Year });
  });

  it('reads a month as its first day', () => {
    expect(parsePartialDate('2019-03')).toEqual({
      on: new Date('2019-03-01T00:00:00Z'),
      precision: DatePrecision.Month,
    });
  });

  it('reads a day', () => {
    expect(parsePartialDate('2019-03-02')).toEqual({
      on: new Date('2019-03-02T00:00:00Z'),
      precision: DatePrecision.Day,
    });
  });

  it('accepts a leap day only in a leap year', () => {
    expect(parsePartialDate('2024-02-29')).not.toBeNull();
    expect(parsePartialDate('2019-02-29')).toBeNull();
  });

  it.each(['2019-3', '19', '2019-03-02T00:00Z', '2019-13', '2019-00', '2019-04-31', '0000', '', ' 2019', '2019-03-2'])(
    'refuses %j',
    (text) => {
      expect(parsePartialDate(text)).toBeNull();
    },
  );

  it('keeps a year below 100 as written, not as 19xx', () => {
    expect(parsePartialDate('0050')).toEqual({ on: new Date('0050-01-01T00:00:00Z'), precision: DatePrecision.Year });
  });
});

describe('formatPartialDate (#1231)', () => {
  it.each(['2019', '2019-03', '2019-03-02', '0050-07'])('round-trips %s', (text) => {
    expect(formatPartialDate(dateOf(text))).toBe(text);
  });
});

describe('partialDateFromColumns (#1231)', () => {
  it('is null when the date is unknown', () => {
    expect(partialDateFromColumns(null, null)).toBeNull();
  });

  it('pairs the stored day with its precision', () => {
    expect(partialDateFromColumns(new Date('2019-03-01T00:00:00Z'), DatePrecision.Month)).toEqual(dateOf('2019-03'));
  });
});

describe('lastDayOf (#1231)', () => {
  it('is the date itself at day precision', () => {
    expect(lastDayOf(dateOf('2019-03-02'))).toEqual(new Date('2019-03-02T00:00:00Z'));
  });

  it('is the last day of the month, leap days included', () => {
    expect(lastDayOf(dateOf('2024-02'))).toEqual(new Date('2024-02-29T00:00:00Z'));
    expect(lastDayOf(dateOf('2023-02'))).toEqual(new Date('2023-02-28T00:00:00Z'));
  });

  it('is December 31 for a year', () => {
    expect(lastDayOf(dateOf('2019'))).toEqual(new Date('2019-12-31T00:00:00Z'));
  });
});

describe('todayUtc (#1231)', () => {
  it('is the UTC day of the clock, whatever the hour', () => {
    expect(todayUtc(new Date('2026-11-26T23:30:00Z'))).toEqual(dateOf('2026-11-26'));
  });
});

describe('latestToday (#1231)', () => {
  // UTC+14 reaches each day first, so at 10:00 UTC it is already tomorrow there.
  it('is the day at UTC+14', () => {
    expect(latestToday(new Date('2026-11-26T09:59:59Z'))).toEqual(dateOf('2026-11-26'));
    expect(latestToday(new Date('2026-11-26T10:00:00Z'))).toEqual(dateOf('2026-11-27'));
  });
});

// A user may not record a day that has not come yet anywhere on Earth. No
// user's zone is stored, so a day that is today somewhere passes: judged by
// UTC, a user east of it would be refused their own today. A year or a month
// that has begun may be recorded, because its first day is not in the future.
describe('assertNotInFuture (#1231)', () => {
  describe('late in the UTC day, when UTC+14 is a day ahead', () => {
    const now = new Date('2026-11-26T23:30:00Z');

    it.each(['2026', '2026-11', '2026-11-26', '2026-11-27', '2019-03-02'])('accepts %s', (text) => {
      expect(() => assertNotInFuture(dateOf(text), now, 'acquiredOn')).not.toThrow();
    });

    it.each(['2026-11-28', '2027', '2026-12'])('refuses %s with COLLECTION_DATE_IN_FUTURE', (text) => {
      expect(refusal(() => assertNotInFuture(dateOf(text), now, 'acquiredOn'))).toMatchObject(DATE_IN_FUTURE);
    });
  });

  // At 05:00 UTC it is 19:00 at UTC+14, still the same day.
  describe('early in the UTC day, when UTC+14 is the same day', () => {
    const now = new Date('2026-11-26T05:00:00Z');

    it('accepts today', () => {
      expect(() => assertNotInFuture(dateOf('2026-11-26'), now, 'acquiredOn')).not.toThrow();
    });

    it('refuses tomorrow with COLLECTION_DATE_IN_FUTURE', () => {
      expect(refusal(() => assertNotInFuture(dateOf('2026-11-27'), now, 'acquiredOn'))).toMatchObject(DATE_IN_FUTURE);
    });
  });

  // A PATCH may send both dates, so the refusal says which (#1231).
  it.each(['acquiredOn', 'removedOn'] as const)('names %s in the refusal', (field) => {
    const refused = refusal(() => assertNotInFuture(dateOf('2099'), new Date('2026-11-26T00:00:00Z'), field));

    expect(fieldsOf(refused)).toMatchObject({ code: 'COLLECTION_DATE_IN_FUTURE', field });
  });

  // An unknown date is in no future, so a restore of a revision with none passes (#1231).
  it('accepts an unknown date', () => {
    expect(() => assertNotInFuture(null, new Date('2026-11-26T00:00:00Z'), 'occurredOn')).not.toThrow();
  });
});

// The one reading of a date a request sent, which the DTO's validation has
// passed: no route refuses such a date in a way of its own (#1231).
describe('sentDate (#1231)', () => {
  const now = new Date('2026-11-26T23:30:00Z');

  it('reads a date sent at its precision', () => {
    expect(sentDate('2019-03', now, 'occurredOn')).toEqual({
      on: new Date('2019-03-01T00:00:00Z'),
      precision: DatePrecision.Month,
    });
  });

  it.each([undefined, null])('answers null for %s: no date sent, or one made unknown', (text) => {
    expect(sentDate(text, now, 'removedOn')).toBeNull();
  });

  it('refuses a day that is today nowhere yet with COLLECTION_DATE_IN_FUTURE, naming the field', () => {
    expect(fieldsOf(refusal(() => sentDate('2026-11-28', now, 'occurredOn')))).toMatchObject({
      code: 'COLLECTION_DATE_IN_FUTURE',
      field: 'occurredOn',
    });
  });
});

// A copy cannot go before it came: a removal in the same year as an
// acquisition on a known day passes only when the year's end is not before it.
describe('assertRemovalAfterAcquisition (#1231)', () => {
  it('accepts a removal whose period reaches the acquisition day', () => {
    expect(() => assertRemovalAfterAcquisition(dateOf('2019-06-20'), dateOf('2019'))).not.toThrow();
  });

  it('accepts the same day', () => {
    expect(() => assertRemovalAfterAcquisition(dateOf('2019-06-20'), dateOf('2019-06-20'))).not.toThrow();
  });

  it('refuses a removal that ends before the acquisition with COLLECTION_DATE_ORDER', () => {
    expect(refusal(() => assertRemovalAfterAcquisition(dateOf('2019-06-20'), dateOf('2019-05')))).toMatchObject(
      DATE_ORDER,
    );
  });

  it.each([
    ['acquisition', null, '2019-05'],
    ['removal', '2019-06-20', null],
    ['both', null, null],
  ])('passes when the %s is unknown', (_side, acquired, removed) => {
    expect(() =>
      assertRemovalAfterAcquisition(
        acquired === null ? null : dateOf(acquired),
        removed === null ? null : dateOf(removed),
      ),
    ).not.toThrow();
  });
});

// A removal sent with no date is dated today in UTC, unless the copy was
// acquired on a later day: the latest today on Earth lets a copy be acquired
// on a day that is tomorrow in UTC, and the removal can't end before it began
// (#1231).
describe('defaultRemovalDate (#1231)', () => {
  const NOW = new Date('2026-11-26T23:30:00Z');

  it('is today in UTC, at Day precision, when the acquisition is unknown', () => {
    expect(defaultRemovalDate(null, NOW)).toEqual(dateOf('2026-11-26'));
  });

  it.each(['2026-11-20', '2026-11-26', '2026-11', '2026', '2019-03'])(
    'is today in UTC for an acquisition of %s, which begins no later than today',
    (acquired) => {
      expect(defaultRemovalDate(dateOf(acquired), NOW)).toEqual(dateOf('2026-11-26'));
    },
  );

  it('is the acquisition day when the copy was acquired on a day later than today in UTC', () => {
    expect(defaultRemovalDate(dateOf('2026-11-27'), NOW)).toEqual(dateOf('2026-11-27'));
  });

  // "2026-12" has begun at UTC+14 on 2026-11-30 at 10:00 UTC or later; its
  // first day is the day the removal is dated, at Day precision.
  it('is the first day of a later month, at Day precision', () => {
    expect(defaultRemovalDate(dateOf('2026-12'), new Date('2026-11-30T23:30:00Z'))).toEqual(dateOf('2026-12-01'));
  });
});
