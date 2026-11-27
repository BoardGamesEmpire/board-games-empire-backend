/**
 * Where a newest-first page ended: the last row's `createdAt` and `id`. The
 * next page starts at the first row after it in (`createdAt` desc, `id` desc)
 * order, whether or not that row still exists (#1597).
 */
export interface KeysetPosition {
  readonly createdAt: Date;
  readonly id: string;
}

/**
 * The newest-first "after this position" clause {@link olderThan} builds. A
 * plain object rather than a Prisma type, so `@bge/shared` stays free of the
 * generated client, and any model with `createdAt` and `id` accepts it.
 */
export interface KeysetOlderThan {
  OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }];
}

/**
 * The longest cursor the decoder reads. An encoded position runs to about 130
 * characters at the longest id it accepts, so this leaves room and still stops
 * a 10 KB string before any decoding work (#1597).
 */
export const MAX_CURSOR_LENGTH = 256;

/** The longest id a cursor may carry. A cuid2 id is 24 characters. */
const MAX_CURSOR_ID_LENGTH = 64;

/**
 * The only date shape `toISOString()` writes for years 0001 to 9999. A year
 * outside it (0000, negative, or six digits with a sign) also round-trips
 * through `toISOString()`, but Postgres has no year 0 and the pg adapter
 * writes the others as timestamps Postgres refuses, so the read would fail
 * with a 500 instead of the caller's 400 (#1597).
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Node's base64url decoder skips characters outside the alphabet instead of
 * failing, so `not base64!` would decode as if it read `notbase64`. The
 * alphabet is checked first; padding is never part of an encoded cursor.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The opaque cursor a client passes back as `?cursor=`: base64url of
 * `[createdAt ISO string, id]`. Opaque so clients don't build one by hand, and
 * so its shape can change without changing the contract (#1597).
 *
 * Ids are expected to be cuid2-length. The encoder does not check the length,
 * but {@link decodeKeysetCursor} refuses an id over 64 characters, so a longer
 * one would produce a cursor the next request is refused for.
 */
export function encodeKeysetCursor(position: KeysetPosition): string {
  return Buffer.from(JSON.stringify([position.createdAt.toISOString(), position.id]), 'utf8').toString('base64url');
}

/**
 * Reads a cursor back to its position, or `null` for anything that is not
 * exactly what {@link encodeKeysetCursor} writes. It never throws: the input
 * comes straight from a query string, and a malformed cursor is the caller's
 * 400, not the server's 500 (#1597).
 *
 * It accepts only base64url of a JSON array of exactly two strings, where:
 *
 * - the date is `YYYY-MM-DDTHH:mm:ss.sssZ` with a year from 0001 to 9999, and
 *   canonical: `new Date(s).toISOString() === s`. That refuses an impossible
 *   date such as month 13 (checked before `toISOString()`, which throws on an
 *   invalid date), a date-only string, a bare number, an offset, and the years
 *   Postgres cannot store;
 * - the id is 1 to 64 characters with no NUL, which Postgres refuses in text.
 *
 * Last, the position must encode back to the very same cursor, so whitespace
 * or escapes inside the JSON are refused too and each position has one cursor.
 */
export function decodeKeysetCursor(cursor: string): KeysetPosition | null {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return null;
  }

  const [iso, id]: unknown[] = parsed;

  if (
    typeof iso !== 'string' ||
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_CURSOR_ID_LENGTH ||
    id.includes('\u0000')
  ) {
    return null;
  }

  if (!ISO_DATE.test(iso) || iso.startsWith('0000')) {
    return null;
  }

  const createdAt = new Date(iso);

  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) {
    return null;
  }

  const position = { createdAt, id };

  return encodeKeysetCursor(position) === cursor ? position : null;
}

/**
 * The rows after `position` in newest-first order: older ones, and those
 * stamped at the same instant with a smaller id. The id arm is what keeps a
 * page boundary inside a `createMany` batch, which shares one `createdAt`,
 * from skipping or repeating rows. Compared by value, so a deleted cursor row
 * still marks where the next page starts (#1597).
 */
export function olderThan(position: KeysetPosition): KeysetOlderThan {
  return {
    OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lt: position.id } }],
  };
}
