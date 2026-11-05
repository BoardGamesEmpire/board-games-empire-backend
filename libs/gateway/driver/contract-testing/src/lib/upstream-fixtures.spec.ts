import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFixture, writeFixture } from './upstream-fixtures.js';

/**
 * An upstream fixture is an upstream's answer, recorded once, so a driver
 * can be run against it offline (#1082).
 */
describe('upstream fixtures', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'upstream-fixtures-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('names a missing fixture and how to record it', () => {
    expect(() => readFixture(dir, 'thing__id=1.xml')).toThrow(
      `no upstream fixture thing__id=1.xml in ${dir}; record it with BGE_RECORD_UPSTREAM=true`,
    );
  });

  it('reads back what was written, creating the directory', () => {
    const fixtures = join(dir, 'fixtures');

    writeFixture(fixtures, 'thing__id=1.xml', '<items><item id="1"/></items>');

    expect(readFixture(fixtures, 'thing__id=1.xml')).toBe('<items><item id="1"/></items>');
  });
});
