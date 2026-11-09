import { parsePluginArtifactSha256, type PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';

/**
 * A checksum as a server admin sends it, trimmed and lowercased, or `null`
 * when it is not one (#1094). Posting an artifact, reading it back and
 * installing it all take the checksum this way, so a value copied in
 * capitals, as some tools print it, names the same artifact on every route.
 */
export const parseRequestedSha256 = (raw: string): PluginArtifactSha256 | null =>
  parsePluginArtifactSha256(raw.trim().toLowerCase());
