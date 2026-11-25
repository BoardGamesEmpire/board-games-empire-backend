export { PluginArchiveRefusedError } from '@boardgamesempire/plugin-analysis';

/**
 * Untrusted text (an archive's entry name, a checksum a client sent): quote it
 * and cut it so it cannot forge lines in a message. Kept in step with the
 * copy in `@boardgamesempire/plugin-analysis`' archive.errors.ts (#1093).
 */
const printable = (entry: string): string => {
  const quoted = JSON.stringify(entry);
  return quoted.length > 200 ? `${quoted.slice(0, 200)}...` : quoted;
};

/**
 * The plugin artifact's bytes do not have the checksum the server admin
 * expected (#1094), and nothing of them is kept. `actualSha256` is null when
 * the expected value is not a checksum at all, so there was nothing to
 * compare.
 */
export class PluginArtifactChecksumMismatchError extends Error {
  override readonly name = 'PluginArtifactChecksumMismatchError';

  constructor(
    readonly expectedSha256: string,
    readonly actualSha256: string | null,
  ) {
    super(
      actualSha256 === null
        ? `The expected checksum ${printable(expectedSha256)} is not a SHA-256 checksum: it must be 64 hexadecimal characters.`
        : `The plugin artifact's checksum is ${actualSha256}, not the expected ${expectedSha256}.`,
    );
  }
}

/** The plugin artifact is larger than a plugin artifact may be (#1094), and nothing of it is kept. */
export class PluginArtifactTooLargeError extends Error {
  override readonly name = 'PluginArtifactTooLargeError';

  constructor(
    readonly limitBytes: number,
    options?: ErrorOptions,
  ) {
    super(`The plugin artifact is larger than the limit of ${limitBytes} bytes.`, options);
  }
}

/** Why the server would not fetch a link. */
export type PluginArtifactLinkRefusal =
  'invalid-link' | 'blocked-by-policy' | 'redirect-blocked' | 'too-many-redirects';

const LINK_REFUSALS: Readonly<Record<PluginArtifactLinkRefusal, string>> = {
  'invalid-link':
    'The link is not one the server can use: it must be an http or https address, with no username or password in it.',
  'blocked-by-policy': "The server's outbound HTTP policy does not allow the link's address.",
  'redirect-blocked': "The link redirects to an address the server's outbound HTTP policy does not allow.",
  'too-many-redirects': 'The link redirects too many times.',
};

/**
 * The server will not fetch the link (#1094): it is not a usable address, or
 * it leads somewhere the outbound HTTP policy refuses. Nothing is kept.
 */
export class PluginArtifactLinkRefusedError extends Error {
  override readonly name = 'PluginArtifactLinkRefusedError';

  constructor(
    readonly reason: PluginArtifactLinkRefusal,
    options?: ErrorOptions,
  ) {
    super(LINK_REFUSALS[reason], options);
  }
}

/** Why a link the server was allowed to fetch did not deliver a plugin artifact. */
export type PluginArtifactDownloadFailure = 'upstream-status' | 'unreachable' | 'timeout';

const DOWNLOAD_FAILURES: Readonly<Record<PluginArtifactDownloadFailure, (status: number | null) => string>> = {
  'upstream-status': (status) => `The link answered with HTTP status ${status} instead of the plugin artifact.`,
  unreachable: () => 'The server could not reach the link.',
  timeout: () => 'The download did not finish within the time limit.',
};

/**
 * The download of a plugin artifact failed (#1094), and nothing is kept.
 * `upstreamStatus` is the status the link answered with, for
 * `upstream-status`, and null otherwise.
 */
export class PluginArtifactDownloadFailedError extends Error {
  override readonly name = 'PluginArtifactDownloadFailedError';

  constructor(
    readonly reason: PluginArtifactDownloadFailure,
    readonly upstreamStatus: number | null,
    options?: ErrorOptions,
  ) {
    super(DOWNLOAD_FAILURES[reason](upstreamStatus), options);
  }
}

/**
 * No plugin artifact with this checksum is waiting on this server (#1094): it
 * was never received, it expired, it was installed or staged as an update, or
 * its directory is gone. Install and update staging both refuse with it, so
 * its message names neither (#1096).
 */
export class PluginArtifactNotFoundError extends Error {
  override readonly name = 'PluginArtifactNotFoundError';

  constructor(readonly sha256: string) {
    super(`No plugin artifact with the checksum ${printable(sha256)} is waiting on this server.`);
  }
}

/**
 * The plugin artifact named for a staged update of plugin `slug` is for
 * another plugin, `artifactSlug` (#1096). Nothing is staged, and the
 * artifact's row is kept for the plugin it is for.
 */
export class PluginArtifactBelongsToAnotherPluginError extends Error {
  override readonly name = 'PluginArtifactBelongsToAnotherPluginError';

  constructor(
    readonly slug: string,
    readonly artifactSlug: string,
    readonly sha256: string,
  ) {
    super(`The plugin artifact ${sha256} is for plugin '${artifactSlug}', not '${slug}'.`);
  }
}
