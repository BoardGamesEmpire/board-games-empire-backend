import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectGolden, isRecordingGolden } from './golden.js';

/**
 * A golden output is what a DataGateway sent, recorded once, so a later
 * version of it can be checked against it (#1082).
 */
describe('expectGolden', () => {
  const recording = process.env.BGE_RECORD_GOLDEN;
  let dir: string;

  beforeEach(() => {
    delete process.env.BGE_RECORD_GOLDEN;
    dir = mkdtempSync(join(tmpdir(), 'golden-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });

    if (recording === undefined) {
      delete process.env.BGE_RECORD_GOLDEN;
    } else {
      process.env.BGE_RECORD_GOLDEN = recording;
    }
  });

  it('records the value as 2-space JSON, creating its directory, when BGE_RECORD_GOLDEN is true', () => {
    process.env.BGE_RECORD_GOLDEN = 'true';
    const file = join(dir, 'nested', 'describe.json');

    expect(isRecordingGolden()).toBe(true);
    expectGolden(file, { name: 'Tzolkin', count: 2n });

    expect(readFileSync(file, 'utf8')).toBe('{\n  "name": "Tzolkin",\n  "count": {\n    "$bigint": "2"\n  }\n}\n');
  });

  it('passes when the value equals the golden, a bigint included', () => {
    const file = join(dir, 'ping.json');
    writeFileSync(file, '{ "timestampMs": { "$bigint": "1730764800000" }, "gatewayName": "BoardGameGeekGateway" }\n');

    expect(() =>
      expectGolden(file, { timestampMs: 1730764800000n, gatewayName: 'BoardGameGeekGateway', unset: undefined }),
    ).not.toThrow();
  });

  it('fails naming the missing golden and how to record it', () => {
    const file = join(dir, 'missing.json');

    expect(isRecordingGolden()).toBe(false);
    expect(() => expectGolden(file, {})).toThrow(`no golden at ${file}; record it with BGE_RECORD_GOLDEN=true`);
  });

  it('fails when the value differs from the golden', () => {
    const file = join(dir, 'fetch.json');
    writeFileSync(file, '{ "title": "Tzolk\'in" }\n');

    expect(() => expectGolden(file, { title: 'Tzolkin' })).toThrow();
  });
});
