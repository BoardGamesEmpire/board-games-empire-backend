import {
  PluginArchiveRefusedError,
  PluginArtifactChecksumMismatchError,
  PluginArtifactDownloadFailedError,
  PluginArtifactLinkRefusedError,
  PluginArtifactNotFoundError,
  PluginArtifactTooLargeError,
} from './artifacts.errors';

describe('plugin artifact errors (#1094)', () => {
  const expected = 'a'.repeat(64);
  const actual = 'b'.repeat(64);

  // A client matches on `name`, so each one is its class name and stays put.
  it.each<[Error, string, Record<string, unknown>]>([
    [
      new PluginArtifactChecksumMismatchError(expected, actual),
      'PluginArtifactChecksumMismatchError',
      { expectedSha256: expected, actualSha256: actual },
    ],
    [new PluginArtifactTooLargeError(1024), 'PluginArtifactTooLargeError', { limitBytes: 1024 }],
    [
      new PluginArtifactLinkRefusedError('redirect-blocked'),
      'PluginArtifactLinkRefusedError',
      { reason: 'redirect-blocked' },
    ],
    [
      new PluginArtifactDownloadFailedError('upstream-status', 503),
      'PluginArtifactDownloadFailedError',
      { reason: 'upstream-status', upstreamStatus: 503 },
    ],
    [new PluginArtifactNotFoundError(expected), 'PluginArtifactNotFoundError', { sha256: expected }],
    [
      new PluginArchiveRefusedError('unsafe-path', 'package/../x'),
      'PluginArchiveRefusedError',
      { rule: 'unsafe-path' },
    ],
  ])('%s carries its class name as its stable code, and its fields (#1094)', (error, name, fields) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.constructor.name).toBe(name);
    expect(error).toMatchObject(fields);
  });

  it('says plainly when the expected value is not a checksum at all (#1094)', () => {
    expect(new PluginArtifactChecksumMismatchError('xyz', null).message).toMatch(/is not a SHA-256 checksum/);
    expect(new PluginArtifactChecksumMismatchError(expected, actual).message).toContain(actual);
  });

  it('quotes an untrusted value, so a message cannot forge a log line (#1094)', () => {
    const forged = 'abc\nERROR something else entirely';

    expect(new PluginArtifactNotFoundError(forged).message).not.toContain('\n');
    expect(new PluginArtifactChecksumMismatchError(forged, null).message).not.toContain('\n');
  });

  it.each([
    ['invalid-link', 'no username or password'],
    ['blocked-by-policy', 'outbound HTTP policy'],
    ['redirect-blocked', 'redirects to an address'],
    ['too-many-redirects', 'too many times'],
  ] as const)('explains a link refused as %s (#1094)', (reason, wording) => {
    expect(new PluginArtifactLinkRefusedError(reason).message).toContain(wording);
  });

  it.each([
    ['upstream-status', 404, 'HTTP status 404'],
    ['unreachable', null, 'could not reach'],
    ['timeout', null, 'time limit'],
  ] as const)('explains a download that failed as %s (#1094)', (reason, status, wording) => {
    expect(new PluginArtifactDownloadFailedError(reason, status).message).toContain(wording);
  });

  it('keeps the error it was mapped from as its cause, for the operator (#1094)', () => {
    const cause = new Error('connect ECONNREFUSED 8.8.8.8:443');

    expect(new PluginArtifactDownloadFailedError('unreachable', null, { cause }).cause).toBe(cause);
    expect(new PluginArtifactLinkRefusedError('blocked-by-policy', { cause }).cause).toBe(cause);
    expect(new PluginArtifactTooLargeError(1024, { cause }).cause).toBe(cause);
  });
});
