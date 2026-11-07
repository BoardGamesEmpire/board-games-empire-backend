import { parsePluginArtifactSha256, type PluginArtifactSha256 } from '../loader/plugin-artifact-directory.js';

/**
 * For tests (#1117): the checksum made of one hex character repeated 64
 * times, so a spec can name distinct artifacts as `buildPluginArtifactSha256('a')`
 * and `buildPluginArtifactSha256('b')`. Throws when the result is not a
 * checksum, so a typo in a spec fails at the fixture.
 */
export const buildPluginArtifactSha256 = (hexCharacter: string): PluginArtifactSha256 => {
  const parsed = parsePluginArtifactSha256(hexCharacter.repeat(64));

  if (parsed === null) {
    throw new Error(`'${hexCharacter}' repeated 64 times is not a plugin artifact checksum`);
  }

  return parsed;
};
