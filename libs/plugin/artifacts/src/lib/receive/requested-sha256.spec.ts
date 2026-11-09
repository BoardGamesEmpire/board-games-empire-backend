import { parseRequestedSha256 } from './requested-sha256';

describe('parseRequestedSha256 (#1094)', () => {
  it('trims and lowercases a checksum, so every route names the same artifact (#1094)', () => {
    expect(parseRequestedSha256(`  ${'AB'.repeat(32)}\t\n`)).toBe('ab'.repeat(32));
    expect(parseRequestedSha256('ab'.repeat(32))).toBe('ab'.repeat(32));
  });

  it.each(['', 'not a checksum', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `../${'a'.repeat(61)}`])(
    'answers null for %j, which is not a checksum (#1094)',
    (raw) => {
      expect(parseRequestedSha256(raw)).toBeNull();
    },
  );
});
