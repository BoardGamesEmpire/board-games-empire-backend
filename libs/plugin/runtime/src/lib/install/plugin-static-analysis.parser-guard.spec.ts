import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginInstallStaticAnalysisError, PluginStaticAnalysisUnavailableError } from './install.errors';
import { PARSER_CAPABILITY_PROBES } from './parser-capabilities';
import { PluginStaticAnalysisService } from './plugin-static-analysis.service';

/**
 * Isolated from the main analyzer spec on purpose: that suite runs the REAL
 * parsers because the service's value is what they actually surface, while
 * this one substitutes the parser to exercise the environments the
 * capability probe exists to refuse (#219) — a build that honours neither
 * module option key, and a stale major that honours the keys but chokes on
 * modern syntax.
 *
 * The stale major was the genuine meriyah 1.9.15, nested under `jackson-js`
 * by way of `bgg-ts-client`, until both left the tree (#1082). It is now
 * simulated from the partition `PARSER_CAPABILITY_PROBES` records against
 * that release: the two floor probes pass, and the rest fail.
 */
type MeriyahModule = typeof import('meriyah');
type ParseImplementation = MeriyahModule['parse'];

const actualMeriyah = jest.requireActual<MeriyahModule>('meriyah');

/** The probes meriyah 1.9.15 passes under the analyzer's parse options (#219). */
const LEGACY_FLOOR_CAPABILITIES = ['esm-module-parsing', 'dynamic-import'] as const;

const LEGACY_FLOOR_SOURCES = new Set(
  PARSER_CAPABILITY_PROBES.filter((probe) =>
    (LEGACY_FLOOR_CAPABILITIES as readonly string[]).includes(probe.capability),
  ).map((probe) => probe.source),
);

let parseImplementation: ParseImplementation;
let mockedVersion: string | undefined;

jest.mock('meriyah', () => ({
  parse: (...args: Parameters<ParseImplementation>) => parseImplementation(...args),
  get version(): string | undefined {
    return mockedVersion;
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

  it('the legacy floor names real probes — a rename must restate the empirical claim, not silently reshape it', () => {
    const capabilities = new Set(PARSER_CAPABILITY_PROBES.map((probe) => probe.capability));

    for (const capability of LEGACY_FLOOR_CAPABILITIES) {
      expect(capabilities).toContain(capability);
    }
  });

  describe('a build that honours neither module option key', () => {
    beforeEach(() => {
      mockedVersion = undefined;
      parseImplementation = () => {
        throw new Error('module parsing unsupported in this build');
      };
    });

    it('refuses to analyze rather than produce a partial-coverage report that reads as complete', async () => {
      const service = new PluginStaticAnalysisService();

      await expect(service.analyze(directory(), { deepScan: false })).rejects.toBeInstanceOf(
        PluginStaticAnalysisUnavailableError,
      );
    });

    it('reports EVERY probe as failed and an unknown version when the build exports none', async () => {
      const failure = await new PluginStaticAnalysisService()
        .analyze(directory(), { deepScan: false })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginStaticAnalysisUnavailableError);

      const unavailable = failure as PluginStaticAnalysisUnavailableError;
      expect([...unavailable.failedCapabilities].sort()).toEqual(
        PARSER_CAPABILITY_PROBES.map((probe) => probe.capability).sort(),
      );
      expect(unavailable.parserVersion).toBe('unknown');
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

  describe('the stale major that parses plain imports but fails modern syntax — the #219 scenario', () => {
    beforeEach(() => {
      mockedVersion = '1.9.15';
      parseImplementation = ((source, options) => {
        if (!LEGACY_FLOOR_SOURCES.has(source)) {
          throw new SyntaxError('[1:0]: Unexpected token');
        }

        return actualMeriyah.parse(source, options);
      }) as ParseImplementation;
    });

    it('is refused: passing the legacy floor is not capability for a full scan', async () => {
      const failure = await new PluginStaticAnalysisService()
        .analyze(directory(), { deepScan: false })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginStaticAnalysisUnavailableError);

      const expectedFailed = PARSER_CAPABILITY_PROBES.map((probe) => probe.capability).filter(
        (capability) => !(LEGACY_FLOOR_CAPABILITIES as readonly string[]).includes(capability),
      );

      expect([...(failure as PluginStaticAnalysisUnavailableError).failedCapabilities].sort()).toEqual(
        [...expectedFailed].sort(),
      );
    });

    it('names the resolved version so the operator knows which build they actually got', async () => {
      const failure = await new PluginStaticAnalysisService()
        .analyze(directory(), { deepScan: false })
        .catch((err: unknown) => err);

      expect((failure as PluginStaticAnalysisUnavailableError).parserVersion).toBe('1.9.15');
      expect((failure as Error).message).toContain('1.9.15');
    });
  });

  describe('a capability-complete build', () => {
    beforeEach(() => {
      mockedVersion = actualMeriyah.version;
      parseImplementation = actualMeriyah.parse;
    });

    it('proceeds and still surfaces findings — the guard gates broken parsers, not healthy ones', async () => {
      const report = await new PluginStaticAnalysisService().analyze(directory(), { deepScan: false });

      expect(report.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ specifier: 'axios', severity: 'forbidden' })]),
      );
    });
  });
});
