import { DatePrecision } from '@bge/database';
import { dateInFuture, dateOrder } from '../game-collection.errors';

/**
 * A date known only as well as the user knows it: a year, a month or a day
 * (#1231). `on` is the first day of the period at UTC midnight, so "2019" is
 * 2019-01-01 at `Year`; `precision` says how much of it was meant.
 */
export interface PartialDate {
  on: Date;
  precision: DatePrecision;
}

const PARTIAL_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * UTC midnight of a calendar day. `Date.UTC` reads the years 0 to 99 as 1900
 * to 1999, so the year is set on its own.
 */
function utcDay(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);

  return date;
}

/**
 * Reads `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, and nothing else: no time, no zone,
 * no unpadded month, and a day that exists on the calendar. Year 0000 is
 * refused, as no game was acquired then. Null when the text is none of these.
 */
export function parsePartialDate(text: string): PartialDate | null {
  const match = PARTIAL_DATE.exec(text);

  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = match[2] === undefined ? 1 : Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);

  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return null;
  }

  const on = utcDay(year, month, day);

  // A day past the month's end rolls over into the next month.
  if (on.getUTCMonth() !== month - 1) {
    return null;
  }

  const precision =
    match[3] !== undefined ? DatePrecision.Day : match[2] !== undefined ? DatePrecision.Month : DatePrecision.Year;

  return { on, precision };
}

/** The wire form of a date: its own precision's ISO 8601 prefix, such as `2019-03` (#1231). */
export function formatPartialDate({ on, precision }: PartialDate): string {
  const iso = on.toISOString();

  switch (precision) {
    case DatePrecision.Year:
      return iso.slice(0, 4);
    case DatePrecision.Month:
      return iso.slice(0, 7);
    default:
      return iso.slice(0, 10);
  }
}

/** Pairs the two stored columns; a date with either one missing is unknown (#1231). */
export function partialDateFromColumns(on: Date | null, precision: DatePrecision | null): PartialDate | null {
  if (on === null || precision === null) {
    return null;
  }

  return { on, precision };
}

/** The last day the date could mean: the day itself, the month's end or December 31 (#1231). */
export function lastDayOf({ on, precision }: PartialDate): Date {
  const year = on.getUTCFullYear();
  const month = on.getUTCMonth() + 1;

  switch (precision) {
    case DatePrecision.Year:
      return utcDay(year, 12, 31);
    case DatePrecision.Month:
      // Day 0 of the next month is the last day of this one.
      return utcDay(year, month + 1, 0);
    default:
      return on;
  }
}

/** The UTC day `now` falls on. The server's zone never decides what "today" is (#1231). */
export function todayUtc(now: Date): PartialDate {
  return {
    on: utcDay(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()),
    precision: DatePrecision.Day,
  };
}

/**
 * Refuses a date that begins after today (UTC). A year or month that has
 * begun passes, because its first day is not in the future (#1231).
 */
export function assertNotInFuture(date: PartialDate, now: Date): void {
  if (date.on.getTime() > todayUtc(now).on.getTime()) {
    throw dateInFuture();
  }
}

/**
 * Refuses a removal that ended before the acquisition began. Compared at the
 * least favourable reading of the removal, its last day, so "2019" after a
 * June 2019 acquisition passes. Either side unknown passes (#1231).
 */
export function assertRemovalAfterAcquisition(acquired: PartialDate | null, removed: PartialDate | null): void {
  if (acquired === null || removed === null) {
    return;
  }

  if (lastDayOf(removed).getTime() < acquired.on.getTime()) {
    throw dateOrder();
  }
}
