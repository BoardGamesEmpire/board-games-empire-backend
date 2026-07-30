import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginInstallStaticAnalysisError, PluginStaticAnalysisUnavailableError } from './install.errors';
import { PluginStaticAnalysisService } from './plugin-static-analysis.service';

/**
 * Isolated from the main analyzer spec on purpose: that suite runs the REAL
 * parsers because the service's value is what they actually surface, while
 * this one mocks meriyah to stand in for a build that honours neither the
 * modern nor the legacy module option — the environment the sanity probe
 * exists to refuse.
 */
jest.mock('meriyah', () => ({
  parse: () => {
    throw new Error('module parsing unsupported in this build');
  },
}));

describe('PluginStaticAnalysisService parser guard', () => {
  let rootDir: string;

  const directory = (): InstalledPluginDirectory => ({
    slug: 'demo-sink',
    rootDir,
    manifestPath: join(rootDir, 'manifest.json'),
    packageJsonPath: join(rootDir, 'package.json'),
    bundled: false,
  });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'bge-parser-guard-'));
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'demo-sink', version: '1.0.0' }), 'utf-8');
    await writeFile(join(rootDir, 'index.js'), "import 'axios';\n", 'utf-8');
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('refuses to analyze rather than produce a partial-coverage report that reads as complete', async () => {
    const service = new PluginStaticAnalysisService();

    await expect(service.analyze(directory(), { deepScan: false })).rejects.toBeInstanceOf(
      PluginStaticAnalysisUnavailableError,
    );
  });

  it('throws on EVERY attempt — a broken environment is not cached as checked', async () => {
    const service = new PluginStaticAnalysisService();

    await service.analyze(directory(), { deepScan: false }).catch(() => undefined);

    await expect(service.analyze(directory(), { deepScan: false })).rejects.toBeInstanceOf(
      PluginStaticAnalysisUnavailableError,
    );
  });

  it('is an environment error, distinct from the findings-gate rejection C4 maps separately', async () => {
    const failure = await new PluginStaticAnalysisService()
      .analyze(directory(), { deepScan: false })
      .catch((err: unknown) => err);

    expect(failure).not.toBeInstanceOf(PluginInstallStaticAnalysisError);
    expect((failure as Error).message).toContain('partial coverage');
  });
});
