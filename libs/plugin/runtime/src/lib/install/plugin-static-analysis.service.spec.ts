import { PluginStaticAnalysisUnavailableError as AnalysisUnavailableError } from '@boardgamesempire/plugin-analysis';
import type { PluginArtifactDirectory } from '@boardgamesempire/plugin-contract';
import { buildPluginArtifactSha256 as sha } from '@boardgamesempire/plugin-contract';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginInstallStaticAnalysisError, PluginStaticAnalysisUnavailableError } from './install.errors';
import { PluginStaticAnalysisService } from './plugin-static-analysis.service';

/**
 * The scan itself is covered where it lives, in `plugin-analysis`. This spec
 * pins what the server's wrapper adds or must not lose (#1093): the result
 * for a real directory reaches the caller untouched, and an unusable parser
 * still surfaces as the one error class the exception filter maps.
 *
 * The parser is substituted so the second case can simulate a build that
 * fails every capability probe; by default it is the real one.
 */
type MeriyahModule = typeof import('meriyah');
type ParseImplementation = MeriyahModule['parse'];

const actualMeriyah = jest.requireActual<MeriyahModule>('meriyah');

let parseImplementation: ParseImplementation;

jest.mock('meriyah', () => ({
  parse: (...args: Parameters<ParseImplementation>) => parseImplementation(...args),
  get version(): string {
    return actualMeriyah.version;
  },
}));

describe('PluginStaticAnalysisService', () => {
  let rootDir: string;

  const directory = (): PluginArtifactDirectory => ({
    slug: 'demo-sink',
    sha256: sha('a'),
    rootDir,
    manifestPath: join(rootDir, 'manifest.json'),
    packageJsonPath: join(rootDir, 'package.json'),
  });

  beforeEach(async () => {
    parseImplementation = actualMeriyah.parse;
    rootDir = await mkdtemp(join(tmpdir(), 'bge-analysis-wrapper-'));
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'demo-sink', version: '1.0.0' }), 'utf-8');
    await writeFile(join(rootDir, 'index.js'), "const axios = require('axios');\nmodule.exports = axios;\n", 'utf-8');
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns the analyzer's report for a plugin directory: one gating cjs-require finding", async () => {
    const report = await new PluginStaticAnalysisService().analyze(directory(), { deepScan: false });

    expect(report.findings).toEqual([
      { file: 'index.js', kind: 'cjs-require', specifier: 'axios', severity: 'forbidden', scanScope: 'default' },
    ]);
    expect(report.scannedFileCount).toBe(1);
    expect(report.truncated).toBe(false);
  });

  it('surfaces an unusable parser as the unavailable error, not the findings-gate rejection C4 maps separately', async () => {
    parseImplementation = () => {
      throw new Error('module parsing unsupported in this build');
    };

    const failure = await new PluginStaticAnalysisService()
      .analyze(directory(), { deepScan: false })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(PluginStaticAnalysisUnavailableError);
    expect(failure).not.toBeInstanceOf(PluginInstallStaticAnalysisError);
    expect((failure as Error).message).toContain('partial coverage');
  });

  it("re-exports the analysis library's own error class, so the filter's instanceof sees one identity (#1093)", () => {
    expect(PluginStaticAnalysisUnavailableError).toBe(AnalysisUnavailableError);
  });
});
