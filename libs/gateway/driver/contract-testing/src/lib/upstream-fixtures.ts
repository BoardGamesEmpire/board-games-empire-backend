import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether this run records upstream answers instead of reading them. Set
 * `BGE_RECORD_UPSTREAM=true` to record; the run then calls the real upstream
 * (#1082).
 */
export const isRecordingUpstream = (): boolean => process.env.BGE_RECORD_UPSTREAM === 'true';

/** The upstream answer recorded as `name` in `dir`. */
export function readFixture(dir: string, name: string): string {
  const file = join(dir, name);

  if (!existsSync(file)) {
    throw new Error(`no upstream fixture ${name} in ${dir}; record it with BGE_RECORD_UPSTREAM=true`);
  }

  return readFileSync(file, 'utf8');
}

/** Records an upstream answer as `name` in `dir`, creating `dir` when it's missing. */
export function writeFixture(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}
