import { decodeKeysetCursor, encodeKeysetCursor, MAX_CURSOR_LENGTH, olderThan } from './keyset-cursor';

const base64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

describe('keyset cursor (#1597)', () => {
  it('round-trips a position, milliseconds included', () => {
    const position = { createdAt: new Date('2026-11-27T10:00:00.123Z'), id: 'n1' };

    expect(decodeKeysetCursor(encodeKeysetCursor(position))).toEqual(position);
  });

  it('encodes to the base64url alphabet only', () => {
    const cursor = encodeKeysetCursor({ createdAt: new Date('2026-11-27T10:00:00.123Z'), id: 'n1?/+=' });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('fits the longest id it accepts inside the length cap', () => {
    const cursor = encodeKeysetCursor({ createdAt: new Date('2026-11-27T10:00:00.123Z'), id: 'x'.repeat(64) });

    expect(cursor.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH);
    expect(decodeKeysetCursor(cursor)).not.toBeNull();
  });

  // Every one of these reaches the decoder straight from a query string, so
  // each must come back null (a 400 at the DTO), never throw (a 500).
  it.each([
    ['the empty string', ''],
    ['a string outside the base64url alphabet', 'not base64!'],
    // Node's decoder skips both of these and reads the valid cursor around
    // them, so only the alphabet check refuses them.
    ['base64 padding', `${base64url('["2026-11-27T10:00:00.000Z","n1"]')}=`],
    ['a foreign character inside a valid cursor', `WyIy!${base64url('["2026-11-27T10:00:00.000Z","n1"]').slice(4)}`],
    ['base64url of non-JSON', base64url('not json')],
    ['base64url of a JSON object', base64url('{"a":1}')],
    ['a one-element array', base64url('["2026-11-27T10:00:00.000Z"]')],
    ['a three-element array', base64url('["2026-11-27T10:00:00.000Z","n1","n2"]')],
    ['a non-string date', base64url('[1764237600000,"n1"]')],
    ['a non-string id', base64url('["2026-11-27T10:00:00.000Z",1]')],
    ['an impossible date (month 13)', base64url('["2026-13-01T00:00:00.000Z","n1"]')],
    ['a date-only string (non-canonical)', base64url('["2026-11-27","n1"]')],
    ['a bare number as the date (non-canonical)', base64url('["1","n1"]')],
    ['a date with an offset (non-canonical)', base64url('["2026-11-27T10:00:00.000+01:00","n1"]')],
    // Each of the next three round-trips through toISOString(), but Postgres
    // has no year 0 and the pg adapter writes the others as timestamps it
    // refuses, which would surface as a 500 from the read.
    ['year 0000', base64url('["0000-01-01T00:00:00.000Z","n1"]')],
    ['a negative year', base64url('["-000001-01-01T00:00:00.000Z","n1"]')],
    ['a six-digit year', base64url('["+010000-01-01T00:00:00.000Z","n1"]')],
    // Postgres refuses NUL in text, so this would also reach the read as a 500.
    ['an id with a NUL character', base64url('["2026-11-27T10:00:00.000Z","a\\u0000b"]')],
    // Decodes to a real position, but is not the one cursor the encoder writes.
    ['a whitespace-padded JSON array', base64url('[ "2026-11-27T10:00:00.000Z", "n1" ]')],
    ['an empty id', base64url('["2026-11-27T10:00:00.000Z",""]')],
    ['an id of 65 characters', base64url(`["2026-11-27T10:00:00.000Z","${'x'.repeat(65)}"]`)],
    ['a 10 KB string', 'A'.repeat(10_000)],
    ['a string one past the length cap', 'A'.repeat(MAX_CURSOR_LENGTH + 1)],
  ])('refuses %s', (_label, cursor) => {
    expect(decodeKeysetCursor(cursor)).toBeNull();
  });

  // Newest first, with id breaking ties: a whole createMany batch shares one
  // createdAt, so a page boundary inside it must continue by id rather than
  // skip or repeat the rest of the batch.
  it('olderThan matches an older row, or a same-instant row with a smaller id', () => {
    const d = new Date('2026-11-27T10:00:00.123Z');

    expect(olderThan({ createdAt: d, id: 'n5' })).toEqual({
      OR: [{ createdAt: { lt: d } }, { createdAt: d, id: { lt: 'n5' } }],
    });
  });
});
