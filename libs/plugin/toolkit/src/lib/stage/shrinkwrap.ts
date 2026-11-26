import { join } from 'node:path';
import { isFile } from '../fs/is-file.js';
import { message } from '../messages.js';
import type { ReportItem } from '../report.js';

const SHRINKWRAP = 'npm-shrinkwrap.json';

/**
 * A SHRINKWRAP_REFUSED error when `stageDir`, the files a plugin artifact
 * would hold, has an npm-shrinkwrap.json (#1093). npm packs that file when
 * there is no `files` field or the field selects it, and npm ci installs from
 * it in place of package-lock.json, while SOURCES.md, the credential check
 * and the dependency screen read package-lock.json. The build refuses it
 * rather than choosing between the two files. One the selection leaves out
 * never reaches the copy npm ci runs in, so it changes nothing.
 */
export const shrinkwrapErrors = async (stageDir: string): Promise<ReportItem[]> =>
  (await isFile(join(stageDir, SHRINKWRAP)))
    ? [{ at: SHRINKWRAP, code: 'SHRINKWRAP_REFUSED', message: message('SHRINKWRAP_REFUSED') }]
    : [];
