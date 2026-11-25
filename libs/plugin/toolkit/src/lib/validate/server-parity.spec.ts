import { isGatingFinding, PluginStaticAnalyzer } from '@boardgamesempire/plugin-analysis';
import type { ManifestIssue, ManifestWarning } from '@boardgamesempire/plugin-manifest';
import {
  buildPluginManifest,
  collectForbiddenPermissionViolations,
  PluginManifestValidationError,
  validatePluginManifest,
} from '@boardgamesempire/plugin-manifest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidateOptions } from '../options.js';
import type { PluginFixtureOptions } from '../testing/plugin-fixture.js';
import { writePluginFixture } from '../testing/plugin-fixture.js';
import { runValidate } from './validate-command.js';

// Every case spawns a real npm, offline: give it room on a slow runner (#1093).
const NPM_TIMEOUT = 60_000;

const OPTIONS: ValidateOptions = { acceptImports: [], bgeVersion: '1.0.0', defaultLocale: 'en' };

interface ServerVerdict {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * What the server's own code says about the plugin folder, called directly:
 * the analyzer a server runs at install, with the scan options it uses by
 * default, the plugin manifest validator, with the options `validate` was
 * given, and the forbidden-permission rule on what it validated (#1093).
 */
const serverVerdict = async (pluginDir: string): Promise<ServerVerdict> => {
  const report = await new PluginStaticAnalyzer().analyze(
    { packageJsonPath: join(pluginDir, 'package.json'), rootDir: pluginDir, slug: 'demo-sink' },
    { deepScan: false },
  );
  let issues: readonly ManifestIssue[] = [];
  let manifestWarnings: readonly ManifestWarning[] = [];
  let forbiddenPermissions = 0;

  try {
    const validated = validatePluginManifest(JSON.parse(await readFile(join(pluginDir, 'manifest.json'), 'utf8')), {
      bgeVersion: OPTIONS.bgeVersion,
      defaultLocale: OPTIONS.defaultLocale,
    });

    manifestWarnings = validated.warnings;
    forbiddenPermissions = collectForbiddenPermissionViolations(validated).length;
  } catch (error) {
    if (!(error instanceof PluginManifestValidationError)) {
      throw error;
    }

    issues = error.issues;
  }

  return {
    errors: [
      ...report.findings.filter((finding) => isGatingFinding(finding)).map((finding) => finding.kind),
      ...issues.map((issue) => issue.code),
      ...Array.from({ length: forbiddenPermissions }, () => 'PLUGIN_PERMISSION_FORBIDDEN'),
    ].sort(),
    warnings: [
      ...report.findings.filter((finding) => !isGatingFinding(finding)).map((finding) => finding.kind),
      ...manifestWarnings.map((warning) => warning.code),
    ].sort(),
  };
};

const FIXTURES: readonly [string, PluginFixtureOptions, readonly string[]][] = [
  ['a plugin that passes every check', {}, []],
  ['a forbidden import', { indexJs: "import axios from 'axios';\nexport default axios;\n" }, ['esm-import']],
  ['a forbidden declared dependency', { packageJson: { dependencies: { axios: '^1.7.0' } } }, ['declared-dependency']],
  ['an advisory finding', { indexJs: "const name = 'fs';\nexport default require(name);\n" }, []],
  [
    'an invalid plugin manifest',
    { manifest: { network: { outboundDomains: ['HTTP://example.com'] }, version: 'not-a-version' } },
    ['OUTBOUND_DOMAIN_INVALID', 'VERSION_INVALID'],
  ],
  [
    'a plugin-administration permission requested as a core permission',
    {
      manifest: {
        permissions: {
          checks: [
            ...buildPluginManifest().permissions.checks,
            {
              reason: { en: 'Installs other plugins on behalf of the server admin.' },
              required: true,
              slug: 'manage:plugin',
            },
          ],
        },
      },
    },
    ['PLUGIN_PERMISSION_FORBIDDEN'],
  ],
];

/**
 * `validate` reaches the server's verdicts on the same manifests and imports
 * (#1093): its errors are exactly the analyzer's gating findings plus the
 * validator's issues and the forbidden-permission rule's violations, and its
 * warnings from the analyzer and the validator are exactly theirs, so
 * a toolkit-side filter that drops or adds a finding fails here.
 */
describe('validate agrees with the server (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-server-parity-spec-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it.each(FIXTURES)(
    '%s',
    async (_name, fixture, expectedErrors) => {
      const pluginDir = await writePluginFixture(root, fixture);
      const server = await serverVerdict(pluginDir);
      const report = await runValidate(pluginDir, OPTIONS);

      expect(report.errors.map((item) => item.code).sort()).toEqual(server.errors);
      expect(report.warnings.map((item) => item.code).sort()).toEqual(server.warnings);
      // The fixture really holds what its name says, so the comparison above is not vacuous.
      expect(server.errors).toEqual([...expectedErrors].sort());
    },
    NPM_TIMEOUT,
  );

  it(
    'agrees on the advisory finding too, so the comparison of warnings is not vacuous',
    async () => {
      const pluginDir = await writePluginFixture(root, FIXTURES[3][1]);

      await expect(serverVerdict(pluginDir)).resolves.toEqual({ errors: [], warnings: ['non-literal-require'] });
    },
    NPM_TIMEOUT,
  );
});
