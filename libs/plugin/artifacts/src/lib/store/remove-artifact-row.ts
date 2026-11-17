import type { PluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import type { Logger } from '@nestjs/common';
import type { PluginArtifactStore } from './plugin-artifact.store';

/**
 * Deletes a plugin artifact's row, best effort, once an install or a staged
 * update has done with it (#1094, #1096): the caller's answer does not depend
 * on it, and a row left behind only waits out its expiry. A failure is logged
 * as a warning, with `situation` saying why the row was being deleted.
 */
export const removeArtifactRowBestEffort = async (
  store: Pick<PluginArtifactStore, 'remove'>,
  logger: Logger,
  sha256: PluginArtifactSha256,
  situation: string,
): Promise<void> => {
  await store.remove(sha256).catch((err: unknown) => {
    logger.warn(
      `${situation}; its artifact row ${sha256} could not be deleted and will wait out its expiry: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
};
