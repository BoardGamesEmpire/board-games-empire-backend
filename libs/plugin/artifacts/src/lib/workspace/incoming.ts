import { createId } from '@paralleldrive/cuid2';
import { mkdir, rm } from 'node:fs/promises';
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
 */
export const allocateIncoming = async (pluginsRoot: string): Promise<IncomingWorkspace> => {
  const incomingDir = join(pluginsRoot, INCOMING_DIRNAME);
  await mkdir(incomingDir, { recursive: true });

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
