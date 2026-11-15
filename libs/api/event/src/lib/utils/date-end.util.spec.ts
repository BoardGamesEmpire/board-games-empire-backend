import { dateEnd, dateNotPassedWhere, hasDatePassed } from './date-end.util';

describe('dateEnd and hasDatePassed (#1005)', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const HOUR = 60 * 60 * 1000;
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  it('never passes a date with no start, whatever its end (#1005)', () => {
    const date = { startDate: null, endDate: at(-HOUR) };

    expect(dateEnd(date)).toBeNull();
    expect(hasDatePassed(date, now)).toBe(false);
  });

  it('passes a date whose start is behind now when it has no end (#1005)', () => {
    expect(hasDatePassed({ startDate: at(-1), endDate: null }, now)).toBe(true);
  });

  it('does not pass a date whose end is still ahead (#1005)', () => {
    expect(hasDatePassed({ startDate: at(-2 * HOUR), endDate: at(HOUR) }, now)).toBe(false);
  });

  it('passes a date whose end is exactly now (#1005)', () => {
    expect(hasDatePassed({ startDate: at(-HOUR), endDate: now }, now)).toBe(true);
  });

  it('moves an end before the start up to the start, so the date has not passed (#1005)', () => {
    const date = { startDate: at(HOUR), endDate: at(-HOUR) };

    expect(dateEnd(date)).toEqual(date.startDate);
    expect(hasDatePassed(date, now)).toBe(false);
  });

  it('passes a date whose start and end are both behind now (#1005)', () => {
    expect(hasDatePassed({ startDate: at(-2 * HOUR), endDate: at(-HOUR) }, now)).toBe(true);
  });

  it('writes the not-passed query form as a start with a start or end still ahead (#1005)', () => {
    expect(dateNotPassedWhere(now)).toEqual({
      startDate: { not: null },
      OR: [{ startDate: { gt: now } }, { endDate: { gt: now } }],
    });
  });
});
