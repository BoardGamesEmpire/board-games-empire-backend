import { expect } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Whether this run records golden outputs instead of checking them. Set
 * `BGE_RECORD_GOLDEN=true` to record, then review the diff of the files it
 * wrote (#1082).
 */
export const isRecordingGolden = (): boolean => process.env.BGE_RECORD_GOLDEN === 'true';

/**
 * A golden as JSON holds it: a bigint, such as a ping's timestamp, becomes
 * `{ "$bigint": "<digits>" }`, and a field set to `undefined` drops out, as
 * it does on the wire.
 */
const toGoldenJson = (value: unknown): string =>
  JSON.stringify(value, (_key, field) => (typeof field === 'bigint' ? { $bigint: field.toString() } : field), 2);

/**
 * Checks `actual` against the golden output recorded in `file`, or records
 * it there when {@link isRecordingGolden}. A golden is what a DataGateway sent
 * for a recorded upstream answer, so a later version of the DataGateway can
 * be held to it: a parity check (#1082).
 */
export function expectGolden(file: string, actual: unknown): void {
  const json = toGoldenJson(actual);

  if (isRecordingGolden()) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${json}\n`);
    return;
  }

  if (!existsSync(file)) {
    throw new Error(`no golden at ${file}; record it with BGE_RECORD_GOLDEN=true`);
  }

  expect(JSON.parse(json)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}
