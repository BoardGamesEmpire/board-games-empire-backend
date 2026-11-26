import { DatePrecision } from '@bge/database';
import type { CopyDateField } from '../game-collection.errors';
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

/**
 * The UTC day `now` falls on: the date a removal with no date, or a change of
 * the rating, records. The server's zone never decides what "today" is
 * (#1231). It is not what a refusal of the future judges by: see
 * {@link latestToday}.
 */
export function todayUtc(now: Date): PartialDate {
  return {
    on: utcDay(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()),
    precision: DatePrecision.Day,
  };
}

/** The earliest zone on Earth, UTC+14 (Kiritimati), which reaches each calendar day first (#1231). */
const EARLIEST_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;

/**
 * The latest calendar day that is today somewhere on Earth: the day at
 * UTC+14 (#1231). No user's time zone is stored, so a date is in the future
 * only when it is after this day. Judged by UTC instead, a user east of UTC
 * would be refused their own today: in Tokyo until 09:00, in Sydney until
 * 11:00.
 */
export function latestToday(now: Date): PartialDate {
  return todayUtc(new Date(now.getTime() + EARLIEST_ZONE_OFFSET_MS));
}

/**
 * Refuses a date that begins after {@link latestToday}, a day that is today
 * nowhere yet, naming `field` in the refusal. A year or month that has begun
 * passes, because its first day is not in the future (#1231).
 */
export function assertNotInFuture(date: PartialDate, now: Date, field: CopyDateField): void {
  if (date.on.getTime() > latestToday(now).on.getTime()) {
    throw dateInFuture(field);
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

/**
 * The date the user gave a removal (#1231): `removedOn` as sent, which the
 * DTO's `@IsPartialDate()` has already passed, or null when they gave none.
 * A date that is today nowhere yet is refused.
 */
export function givenRemovalDate(removedOn: string | undefined, now: Date): PartialDate | null {
  const removal = removedOn === undefined ? null : parsePartialDate(removedOn);

  if (removal !== null) {
    assertNotInFuture(removal, now, 'removedOn');
  }

  return removal;
}

/**
 * The date a removal with no date records (#1231): today in UTC, or, for a
 * copy acquired on a later day, the acquisition's day. A copy can be acquired
 * on a day that is today somewhere on Earth ({@link latestToday}) and
 * tomorrow in UTC, and its removal may not end before it began. At Day
 * precision either way; `acquired` is the copy's own, so each copy of an
 * entry is dated by itself.
 */
export function defaultRemovalDate(acquired: PartialDate | null, now: Date): PartialDate {
  const today = todayUtc(now);

  if (acquired !== null && acquired.on.getTime() > today.on.getTime()) {
    return { on: acquired.on, precision: DatePrecision.Day };
  }

  return today;
}
