import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginStaticAnalysisService } from './plugin-static-analysis.service';
import type { StaticAnalysisFinding, StaticAnalysisReport } from './static-analysis.types';
import {
  gatingFindings,
  isGatingFinding,
  MAX_ADVISORY_FINDINGS,
  MAX_GATING_EXAMPLES_PER_SPECIFIER,
} from './static-analysis.types';

/**
 * Exercised against REAL directories and the real es-module-lexer/meriyah
 * parsers: the service's value is what those parsers actually surface, and
 * mocking them would test the mock.
 */
describe('PluginStaticAnalysisService', () => {
  const service = new PluginStaticAnalysisService();
  let rootDir: string;

  const directory = (): InstalledPluginDirectory => ({
    slug: 'demo-sink',
    rootDir,
    manifestPath: join(rootDir, 'manifest.json'),
    packageJsonPath: join(rootDir, 'package.json'),
    bundled: false,
  });

  const write = async (relativePath: string, content: string): Promise<void> => {
    const path = join(rootDir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf-8');
  };

  const analyze = (deepScan = false): Promise<StaticAnalysisReport> => service.analyze(directory(), { deepScan });

  const findingsBy = (report: StaticAnalysisReport, kind: StaticAnalysisFinding['kind']): StaticAnalysisFinding[] =>
    report.findings.filter((finding) => finding.kind === kind);

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'bge-static-analysis-'));
    await write('package.json', JSON.stringify({ name: 'demo-sink', version: '1.2.0', main: 'index.js' }));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('reports a clean plugin with zero findings and counts the scanned files', async () => {
    await write('index.js', "import { helper } from './lib/helper.mjs';\nexport const run = () => helper();\n");
    await write('lib/helper.mjs', "import { join } from 'node:path';\nexport const helper = () => join('a', 'b');\n");

    const report = await analyze();

    expect(report.findings).toEqual([]);
    expect(report.scannedFileCount).toBe(2);
    expect(report.deepScannedFileCount).toBe(0);
    expect(report.truncated).toBe(false);
  });

  it('flags a forbidden static ESM import as a gating finding with a root-relative path', async () => {
    await write('lib/db.js', "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\n");

    const report = await analyze();

    expect(report.findings).toEqual([
      {
        file: join('lib', 'db.js'),
        kind: 'esm-import',
        specifier: '@prisma/client',
        severity: 'forbidden',
        scanScope: 'default',
      },
    ]);
    expect(gatingFindings(report)).toHaveLength(1);
  });

  it('flags a forbidden require, matching subpath specifiers to their root entry', async () => {
    await write('main.cjs', "const http = require('axios/lib/adapters/http');\nmodule.exports = http;\n");

    const report = await analyze();

    expect(findingsBy(report, 'cjs-require')).toEqual([
      expect.objectContaining({ specifier: 'axios/lib/adapters/http', severity: 'forbidden' }),
    ]);
  });

  it('flags an export-from of a forbidden specifier — re-exports are imports', async () => {
    await write('surface.mjs', "export { fetch } from 'undici';\n");

    const report = await analyze();

    expect(findingsBy(report, 'esm-import')).toEqual([
      expect.objectContaining({ specifier: 'undici', severity: 'forbidden' }),
    ]);
  });

  it('records node:fs / node:net traffic as warnings, never gating', async () => {
    await write(
      'io.js',
      "import { readFile } from 'node:fs/promises';\nconst net = require('node:net');\nexport { readFile, net };\n",
    );

    const report = await analyze();

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'esm-import', specifier: 'node:fs/promises', severity: 'warning' }),
        expect.objectContaining({ kind: 'cjs-require', specifier: 'node:net', severity: 'warning' }),
      ]),
    );
    expect(gatingFindings(report)).toEqual([]);
  });

  it('screens dynamic import() literals and warns on non-literal specifiers instead of rejecting', async () => {
    await write(
      'lazy.js',
      "export const load = async (name) => {\n  await import('ioredis');\n  return import(name);\n};\n",
    );

    const report = await analyze();

    expect(findingsBy(report, 'dynamic-import')).toEqual([
      expect.objectContaining({ specifier: 'ioredis', severity: 'forbidden' }),
    ]);
    expect(findingsBy(report, 'non-literal-import')).toEqual([
      expect.objectContaining({ specifier: null, severity: 'warning' }),
    ]);
  });

  it('warns on require(x) with a non-literal argument', async () => {
    await write('loader.cjs', 'module.exports = (name) => require(name);\n');

    const report = await analyze();

    expect(findingsBy(report, 'non-literal-require')).toEqual([
      expect.objectContaining({ specifier: null, severity: 'warning' }),
    ]);
    expect(gatingFindings(report)).toEqual([]);
  });

  it('records an unparseable file as a parse-failure warning and keeps scanning the rest', async () => {
    await write('broken.js', 'const = = not javascript at all {{{');
    await write('good.js', "import 'iovalkey';\n");

    const report = await analyze();

    expect(findingsBy(report, 'parse-failure')).toEqual([
      expect.objectContaining({ file: 'broken.js', severity: 'warning' }),
    ]);
    expect(findingsBy(report, 'esm-import')).toEqual([
      expect.objectContaining({ file: 'good.js', specifier: 'iovalkey', severity: 'forbidden' }),
    ]);
  });

  it('deduplicates repeated specifiers within a file, keeps distinct files distinct', async () => {
    await write('a.js', "import 'axios';\nimport axios from 'axios';\n");
    await write('b.js', "import 'axios';\n");

    const report = await analyze();

    expect(findingsBy(report, 'esm-import')).toHaveLength(2);
    expect(
      findingsBy(report, 'esm-import')
        .map((finding) => finding.file)
        .sort(),
    ).toEqual(['a.js', 'b.js']);
  });

  it('excludes node_modules from the default scan', async () => {
    await write('index.js', 'export const ok = true;\n');
    await write(
      join('node_modules', 'dep', 'index.js'),
      "const cp = require('node:child_process');\nmodule.exports = cp;\n",
    );

    const report = await analyze();

    expect(report.findings).toEqual([]);
    expect(report.scannedFileCount).toBe(1);
  });

  it('deep scan reaches node_modules and marks every finding advisory (deep scope), forbidden or not', async () => {
    await write('index.js', 'export const ok = true;\n');
    await write(
      join('node_modules', 'dep', 'index.js'),
      "const cp = require('node:child_process');\nmodule.exports = cp;\n",
    );

    const report = await analyze(true);

    expect(report.deepScannedFileCount).toBe(1);
    expect(report.findings).toEqual([
      {
        file: join('node_modules', 'dep', 'index.js'),
        kind: 'cjs-require',
        specifier: 'node:child_process',
        severity: 'forbidden',
        scanScope: 'deep',
      },
    ]);
    expect(gatingFindings(report)).toEqual([]);
  });

  it('screens package.json dependencies by name: a forbidden dependency gates without scanning vendored source', async () => {
    await write(
      'package.json',
      JSON.stringify({ name: 'demo-sink', version: '1.2.0', dependencies: { axios: '^1.7.0', lodash: '^4.17.21' } }),
    );
    await write('index.js', 'export const ok = true;\n');

    const report = await analyze();

    expect(report.findings).toEqual([
      {
        file: 'package.json',
        kind: 'declared-dependency',
        specifier: 'axios',
        severity: 'forbidden',
        scanScope: 'default',
      },
    ]);
    expect(gatingFindings(report)).toHaveLength(1);
  });

  /**
   * The lockfile describes the RESOLVED tree, most of which is transitive —
   * the same third-party code the deep scan treats as advisory — so a
   * forbidden package found there is reported, never gated. The author's own
   * declarations in package.json remain gating.
   */
  describe('lockfile screening is advisory', () => {
    it('reports nested and scoped node_modules keys at warning severity', async () => {
      await write(
        'package-lock.json',
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'demo-sink' },
            'node_modules/lodash': { version: '4.17.21' },
            'node_modules/some-lib/node_modules/@bge/database': { version: '0.0.1' },
          },
        }),
      );
      await write('index.js', 'export const ok = true;\n');

      const report = await analyze();

      expect(report.findings).toEqual([
        {
          file: 'package-lock.json',
          kind: 'lockfile-package',
          specifier: '@bge/database',
          severity: 'warning',
          scanScope: 'default',
        },
      ]);
      expect(gatingFindings(report)).toEqual([]);
    });

    it('does not gate a DEV-only package that appears in the lockfile', async () => {
      await write(
        'package.json',
        JSON.stringify({ name: 'demo-sink', version: '1.2.0', devDependencies: { axios: '^1.7.0' } }),
      );
      await write(
        'package-lock.json',
        JSON.stringify({
          lockfileVersion: 3,
          packages: { '': { name: 'demo-sink' }, 'node_modules/axios': { version: '1.7.0', dev: true } },
        }),
      );

      const report = await analyze();

      // Both screens fire, both advisory — the lockfile must not undo the
      // devDependencies policy through the back door.
      expect(gatingFindings(report)).toEqual([]);
      expect(report.findings.map((finding) => finding.severity)).toEqual(['warning', 'warning']);
    });

    it('does not gate a TRANSITIVE production package the author never chose', async () => {
      await write(
        'package-lock.json',
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'demo-sink' },
            'node_modules/some-sdk': { version: '2.0.0' },
            'node_modules/some-sdk/node_modules/axios': { version: '1.7.0' },
          },
        }),
      );

      const report = await analyze();

      expect(findingsBy(report, 'lockfile-package')).toEqual([
        expect.objectContaining({ specifier: 'axios', severity: 'warning' }),
      ]);
      expect(gatingFindings(report)).toEqual([]);
    });

    it('still gates when the same package is DECLARED directly', async () => {
      await write(
        'package.json',
        JSON.stringify({ name: 'demo-sink', version: '1.2.0', dependencies: { axios: '^1.7.0' } }),
      );
      await write(
        'package-lock.json',
        JSON.stringify({
          lockfileVersion: 3,
          packages: { '': { name: 'demo-sink' }, 'node_modules/axios': { version: '1.7.0' } },
        }),
      );

      const report = await analyze();

      expect(gatingFindings(report)).toEqual([
        expect.objectContaining({ specifier: 'axios', kind: 'declared-dependency' }),
      ]);
    });

    it('walks NESTED v1 dependency trees — v1 nests transitives instead of flattening', async () => {
      await write(
        'package-lock.json',
        JSON.stringify({
          lockfileVersion: 1,
          dependencies: {
            'some-sdk': { version: '2.0.0', dependencies: { axios: { version: '1.7.0' } } },
          },
        }),
      );

      const report = await analyze();

      expect(findingsBy(report, 'lockfile-package')).toEqual([
        expect.objectContaining({ specifier: 'axios', severity: 'warning' }),
      ]);
    });
  });

  it('records an unreadable file as a warning instead of throwing out of analyze()', async () => {
    await write('locked.js', "import 'axios';\n");
    await chmod(join(rootDir, 'locked.js'), 0o000);

    const report = await analyze();

    // A privileged test runner can read a mode-0000 file, so the guard only
    // bites where the environment enforces it; either way analyze() resolves
    // rather than letting a raw EACCES escape install().
    if (findingsBy(report, 'read-failure').length > 0) {
      expect(findingsBy(report, 'read-failure')).toEqual([
        expect.objectContaining({ file: 'locked.js', specifier: null, severity: 'warning' }),
      ]);
      expect(gatingFindings(report)).toEqual([]);
    } else {
      expect(findingsBy(report, 'esm-import')).toEqual([
        expect.objectContaining({ specifier: 'axios', severity: 'forbidden' }),
      ]);
    }

    await chmod(join(rootDir, 'locked.js'), 0o644);
  });

  it('reports an unreadable DIRECTORY rather than reading it as a clean empty scan', async () => {
    await write('src/hidden.js', "import 'axios';\n");
    await write('open.js', "import 'undici';\n");
    await chmod(join(rootDir, 'src'), 0o000);

    const report = await analyze();

    // A privileged runner can list a mode-0000 directory, so the guard only
    // bites where the environment enforces it. Either way an unreadable
    // subtree must never present as a completed scan.
    if (findingsBy(report, 'read-failure').length > 0) {
      expect(findingsBy(report, 'read-failure')).toEqual([
        expect.objectContaining({ file: 'src', specifier: null, severity: 'warning' }),
      ]);
    } else {
      expect(findingsBy(report, 'esm-import')).toEqual(
        expect.arrayContaining([expect.objectContaining({ specifier: 'axios' })]),
      );
    }

    // The readable sibling is screened regardless.
    expect(gatingFindings(report)).toEqual(expect.arrayContaining([expect.objectContaining({ specifier: 'undici' })]));

    await chmod(join(rootDir, 'src'), 0o755);
  });

  it('does not report an ABSENT directory — node_modules is optional', async () => {
    await write('index.js', 'export const ok = true;\n');

    const report = await analyze(true);

    expect(findingsBy(report, 'read-failure')).toEqual([]);
    expect(report.deepScannedFileCount).toBe(0);
  });

  it('forbids the request-shaped builtins — node:https bypasses the outboundDomains surface', async () => {
    await write('fetcher.js', "import { request } from 'node:https';\nexport { request };\n");

    const report = await analyze();

    expect(gatingFindings(report)).toEqual([
      expect.objectContaining({ specifier: 'node:https', severity: 'forbidden' }),
    ]);
  });

  describe('deep-scan bounding', () => {
    it('drops unscreenable kinds from vendored code — require(variable) is noise there', async () => {
      await write('index.js', 'export const ok = true;\n');
      await write(join('node_modules', 'a', 'index.js'), 'module.exports = (n) => require(n);\n');
      await write(join('node_modules', 'b', 'index.js'), 'module.exports = (n) => require(n);\n');

      const report = await analyze(true);

      expect(report.deepScannedFileCount).toBe(2);
      expect(findingsBy(report, 'non-literal-require')).toEqual([]);
    });

    it('reports a vendored forbidden specifier ONCE across the tree, with an example file', async () => {
      await write('index.js', 'export const ok = true;\n');
      await write(join('node_modules', 'a', 'index.js'), "const x = require('axios');\nmodule.exports = x;\n");
      await write(join('node_modules', 'b', 'index.js'), "const x = require('axios');\nmodule.exports = x;\n");

      const report = await analyze(true);

      const vendored = report.findings.filter((finding) => finding.scanScope === 'deep');
      expect(vendored).toHaveLength(1);
      expect(vendored[0]).toEqual(expect.objectContaining({ specifier: 'axios', scanScope: 'deep' }));
      expect(gatingFindings(report)).toEqual([]);
    });

    it("keeps a non-literal require in the PLUGIN's own code — the author can act on that one", async () => {
      await write('loader.cjs', 'module.exports = (n) => require(n);\n');

      const report = await analyze(true);

      expect(findingsBy(report, 'non-literal-require')).toHaveLength(1);
    });

    it('bounds gating findings per specifier so an accepted install cannot persist an unbounded payload', async () => {
      for (let index = 0; index < MAX_GATING_EXAMPLES_PER_SPECIFIER + 20; index += 1) {
        await write(`importer${index}.js`, "import 'axios';\n");
      }
      await write('other.js', "import 'ioredis';\n");

      const report = await analyze();
      const gating = gatingFindings(report);

      expect(gating.filter((finding) => finding.specifier === 'axios')).toHaveLength(MAX_GATING_EXAMPLES_PER_SPECIFIER);
      // The SET is what the gate and the acknowledgement key on, so it must survive intact.
      expect([...new Set(gating.map((finding) => finding.specifier))].sort()).toEqual(['axios', 'ioredis']);
      expect(report.truncated).toBe(true);
    });

    it('caps advisory findings while preserving every gating specifier', async () => {
      for (let index = 0; index < MAX_ADVISORY_FINDINGS + 30; index += 1) {
        await write(`noise${index}.cjs`, 'module.exports = (n) => require(n);\n');
      }
      await write('zbad.js', "import 'axios';\n");

      const report = await analyze();

      expect(report.truncated).toBe(true);
      expect(report.findings.filter((finding) => !isGatingFinding(finding))).toHaveLength(MAX_ADVISORY_FINDINGS);
      // The cap must never swallow a rejection reason.
      expect(gatingFindings(report)).toEqual([expect.objectContaining({ specifier: 'axios', severity: 'forbidden' })]);
    });
  });

  describe('dependency-field screening', () => {
    it('screens optionalDependencies and peerDependencies, not just dependencies', async () => {
      await write(
        'package.json',
        JSON.stringify({
          name: 'demo-sink',
          version: '1.2.0',
          optionalDependencies: { axios: '^1.7.0' },
          peerDependencies: { '@prisma/client': '^6.0.0' },
        }),
      );

      const report = await analyze();

      expect(
        gatingFindings(report)
          .map((finding) => finding.specifier)
          .sort(),
      ).toEqual(['@prisma/client', 'axios']);
    });

    it('screens devDependencies at WARNING severity — not installed in a production tree', async () => {
      await write(
        'package.json',
        JSON.stringify({ name: 'demo-sink', version: '1.2.0', devDependencies: { axios: '^1.7.0' } }),
      );

      const report = await analyze();

      expect(findingsBy(report, 'declared-dependency')).toEqual([
        expect.objectContaining({ specifier: 'axios', severity: 'warning' }),
      ]);
      expect(gatingFindings(report)).toEqual([]);
    });

    it('screens bundleDependencies, which ship inside the tarball', async () => {
      await write(
        'package.json',
        JSON.stringify({ name: 'demo-sink', version: '1.2.0', bundleDependencies: ['undici', 'lodash'] }),
      );

      const report = await analyze();

      expect(gatingFindings(report)).toEqual([expect.objectContaining({ specifier: 'undici', severity: 'forbidden' })]);
    });

    it('resolves an npm: alias range — a rename must not defeat name screening', async () => {
      await write(
        'package.json',
        JSON.stringify({ name: 'demo-sink', version: '1.2.0', dependencies: { 'my-http': 'npm:axios@^1.7.0' } }),
      );
      await write('index.js', "const http = require('my-http');\nmodule.exports = http;\n");

      const report = await analyze();

      // The call site is unlisted by construction; the descriptor is what catches it.
      expect(findingsBy(report, 'cjs-require')).toEqual([]);
      expect(gatingFindings(report)).toEqual([
        expect.objectContaining({ specifier: 'axios', kind: 'declared-dependency' }),
      ]);
    });

    it('resolves an alias recorded in a v3 lockfile entry name field (advisory)', async () => {
      await write(
        'package-lock.json',
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { name: 'demo-sink' },
            'node_modules/my-http': { name: 'axios', version: '1.19.0' },
          },
        }),
      );

      const report = await analyze();

      expect(findingsBy(report, 'lockfile-package')).toEqual([
        expect.objectContaining({ specifier: 'axios', severity: 'warning' }),
      ]);
    });

    it('resolves an alias recorded in a v1 lockfile version field (advisory)', async () => {
      await write(
        'package-lock.json',
        JSON.stringify({
          lockfileVersion: 1,
          dependencies: { 'my-http': { version: 'npm:axios@^1.7.0' } },
        }),
      );

      const report = await analyze();

      expect(findingsBy(report, 'lockfile-package')).toEqual([
        expect.objectContaining({ specifier: 'axios', severity: 'warning' }),
      ]);
    });

    it('resolves the strongest verdict when a package is in BOTH a warning and a gating field', async () => {
      await write(
        'package.json',
        JSON.stringify({
          name: 'demo-sink',
          version: '1.2.0',
          devDependencies: { axios: '^1.7.0' },
          bundleDependencies: ['axios'],
        }),
      );

      const report = await analyze();

      // One finding, upgraded to forbidden — the dedup must not let field
      // iteration order decide severity.
      expect(findingsBy(report, 'declared-dependency')).toEqual([
        expect.objectContaining({ specifier: 'axios', severity: 'forbidden' }),
      ]);
      expect(gatingFindings(report)).toHaveLength(1);
    });

    it('reaches the same verdict with the fields declared in the opposite order', async () => {
      await write(
        'package.json',
        JSON.stringify({
          name: 'demo-sink',
          version: '1.2.0',
          bundleDependencies: ['axios'],
          devDependencies: { axios: '^1.7.0' },
        }),
      );

      const report = await analyze();

      expect(gatingFindings(report)).toHaveLength(1);
    });
  });

  it('ignores non-scannable extensions and survives an absent lockfile', async () => {
    await write('README.md', "# import 'axios' — prose, not code\n");
    await write('data.json', JSON.stringify({ note: "require('ioredis')" }));

    const report = await analyze();

    expect(report.findings).toEqual([]);
    expect(report.scannedFileCount).toBe(0);
  });
});
