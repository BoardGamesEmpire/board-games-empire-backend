import { randomUUID } from 'node:crypto';
import { PLUGIN_ARTIFACT_SHA256_PATTERN, parsePluginArtifactSha256 } from './plugin-artifact-directory.js';

describe('parsePluginArtifactSha256', () => {
  it('brands 64 lowercase hex characters (#1117)', () => {
    expect(parsePluginArtifactSha256('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it.each(['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '../' + 'a'.repeat(61), ''])(
    'refuses %s (#1117)',
    (value) => {
      expect(parsePluginArtifactSha256(value)).toBeNull();
    },
  );
});

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
