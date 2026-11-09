import { createId } from '@paralleldrive/cuid2';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const INCOMING_DIRNAME = '.incoming';

export interface IncomingWorkspace {
  readonly id: string;
  readonly archivePath: string;
  readonly extractDir: string;
  /** Removes both paths; a path that is not there is fine. */
  cleanup(): Promise<void>;
}

/**
 * Names the two scratch paths for one posted plugin artifact (#1094):
 * `<root>/.incoming/<id>.tgz` and `<root>/.incoming/<id>/`. Both are inside the
 * plugins root so the final rename never crosses a filesystem. Only
 * `.incoming/` is created here; the caller makes the paths.
 *
 * A `.incoming` that is a symbolic link is refused: writes through it may land
 * outside the plugins root, and the sweep, which never follows a link, would
 * never clear them.
 *
 * The check catches a link that is already there. It assumes that only the
 * server writes to the plugins root: the check and the writes that follow are
 * separate steps, so a link swapped in between them is not caught.
 */
export const allocateIncoming = async (pluginsRoot: string): Promise<IncomingWorkspace> => {
  const incomingDir = join(pluginsRoot, INCOMING_DIRNAME);
  await mkdir(incomingDir, { recursive: true });

  if ((await lstat(incomingDir)).isSymbolicLink()) {
    throw new Error(`${incomingDir} is a symbolic link; it must be a directory inside the plugins root`);
  }

  const id = createId();
  const archivePath = join(incomingDir, `${id}.tgz`);
  const extractDir = join(incomingDir, id);

  return {
    id,
    archivePath,
    extractDir,
    cleanup: async () => {
      await Promise.all([rm(archivePath, { force: true }), rm(extractDir, { recursive: true, force: true })]);
    },
  };
};
