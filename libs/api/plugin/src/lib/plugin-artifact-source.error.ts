/**
 * A request to post a plugin artifact named neither a link nor a file, or both
 * (#1094). `name` is the stable code a client can match on; `reason` says which.
 * The error lives here, not in the plugin artifacts lib, because the
 * link-or-file choice belongs to the request's shape at the HTTP edge.
 */
export class PluginArtifactSourceError extends Error {
  override readonly name = 'PluginArtifactSourceError';

  constructor(readonly reason: 'none' | 'both') {
    super(
      reason === 'both'
        ? 'Send the plugin artifact as a link or as a file, not both.'
        : 'Send the plugin artifact as a link or as a file.',
    );
  }
}
