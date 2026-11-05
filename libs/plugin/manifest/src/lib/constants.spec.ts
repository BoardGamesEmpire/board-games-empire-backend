import { randomUUID } from 'node:crypto';
import { PLUGIN_ARTIFACT_SHA256_PATTERN } from './constants.js';

describe('PLUGIN_ARTIFACT_SHA256_PATTERN', () => {
  it('accepts 64 lowercase hex characters and nothing else (#224)', () => {
    // The checksum names a plugin artifact's directory, so anything it accepts
    // becomes a path segment: no traversal, no uppercase spelling of the same
    // digest, and no other identifier format that merely looks unique.
    expect(PLUGIN_ARTIFACT_SHA256_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(PLUGIN_ARTIFACT_SHA256_PATTERN.test('0123456789abcdef'.repeat(4))).toBe(true);

    for (const refused of [
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      '../' + 'a'.repeat(61),
      `${'a'.repeat(64)}\n`,
      randomUUID(),
    ]) {
      expect(PLUGIN_ARTIFACT_SHA256_PATTERN.test(refused)).toBe(false);
    }
  });
});
