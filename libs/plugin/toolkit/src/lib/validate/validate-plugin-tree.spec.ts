import { MAX_ADVISORY_FINDINGS } from '@boardgamesempire/plugin-analysis';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidateOptions } from '../options.js';
import type { ReportItem, ValidationReport } from '../report.js';
import { writePluginFixture } from '../testing/plugin-fixture.js';
import { validatePluginTree } from './validate-plugin-tree.js';

const OPTIONS: ValidateOptions = { acceptImports: [], bgeVersion: '1.0.0', defaultLocale: 'en' };

const codes = (items: readonly ReportItem[]): string[] => items.map((item) => item.code);

/** A required household-scope check, which only a household-scope plugin may request. */
const HOUSEHOLD_CHECK = {
  consentScope: 'household' as const,
  reason: { en: 'Reads the games a household owns to suggest what to play next.' },
  required: true,
  slug: 'read:game',
};

describe('validatePluginTree (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-validate-tree-spec-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const validate = async (
    fixture: Parameters<typeof writePluginFixture>[1],
    options: Partial<ValidateOptions> = {},
  ): Promise<ValidationReport> =>
    validatePluginTree(await writePluginFixture(root, fixture), { ...OPTIONS, ...options });

  it('passes the fixture plugin with only the notes on what it cannot check', async () => {
    const report = await validate({});

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(codes(report.notes).sort()).toEqual(
      ['CONSENT_COMPARISON_SKIPPED', 'NOT_CHECKED_BEYOND_SCAN', 'NOT_CHECKED_PERMISSION_CATALOG'].sort(),
    );
  });

  describe('forbidden imports', () => {
    const AXIOS = "const axios = require('axios');\nmodule.exports = { axios };\n";

    it('reports a forbidden require as an error at its file, naming the import', async () => {
      const report = await validate({ indexJs: AXIOS, packageJson: { type: 'commonjs' } });

      expect(report.errors).toEqual([
        { at: 'dist/index.js', code: 'cjs-require', message: expect.stringContaining('"axios"') },
      ]);
    });

    it('turns an accepted forbidden import into a note, and the report has no error', async () => {
      const report = await validate(
        { indexJs: AXIOS, packageJson: { type: 'commonjs' } },
        { acceptImports: ['axios'] },
      );

      expect(report.errors).toEqual([]);
      expect(report.notes).toContainEqual({
        at: 'dist/index.js',
        code: 'FORBIDDEN_IMPORT_ACCEPTED',
        message: expect.stringContaining('"axios"'),
      });
    });

    it('warns about an accepted import the scan never found', async () => {
      const report = await validate({}, { acceptImports: ['pg'] });

      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([
        { code: 'ACCEPTED_IMPORT_NOT_FOUND', message: expect.stringContaining('"pg"') },
      ]);
    });

    it('says so in a note when the scan cut its list of findings short', async () => {
      const files: Record<string, string> = {};

      for (let i = 0; i <= MAX_ADVISORY_FINDINGS; i += 1) {
        files[`dist/lazy-${i}.js`] = 'export default (name) => require(name);\n';
      }

      const report = await validate({ files });

      expect(report.errors).toEqual([]);
      expect(report.warnings).toHaveLength(MAX_ADVISORY_FINDINGS);
      expect(codes(report.notes)).toContain('SCAN_REPORT_TRUNCATED');
    });

    it('reports an advisory finding as a warning only', async () => {
      const report = await validate({ indexJs: "const name = 'fs';\nexport default require(name);\n" });

      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([
        { at: 'dist/index.js', code: 'non-literal-require', message: expect.any(String) },
      ]);
    });
  });

  it('refuses a plugin-administration permission requested as a core permission', async () => {
    const base = buildPluginManifest();
    const report = await validate({
      manifest: {
        permissions: {
          checks: [
            ...base.permissions.checks,
            {
              reason: { en: 'Installs other plugins on behalf of the server admin.' },
              required: true,
              slug: 'manage:plugin',
            },
          ],
        },
      },
    });

    expect(report.errors).toEqual([
      {
        at: 'permissions.checks[2]',
        code: 'PLUGIN_PERMISSION_FORBIDDEN',
        message: expect.stringContaining('"manage:plugin"'),
      },
    ]);
  });

  it("reports each issue in the plugin manifest with its path and the validator's own message", async () => {
    const report = await validate({ manifest: { version: 'not-a-version' } });

    expect(report.errors).toEqual([
      { at: 'version', code: 'VERSION_INVALID', message: "'not-a-version' is not a valid semver version" },
    ]);
  });

  it("passes the validator's warnings through as warnings", async () => {
    const base = buildPluginManifest();
    const report = await validate({
      manifest: { permissions: { checks: [...base.permissions.checks, HOUSEHOLD_CHECK] }, scope: 'household' },
    });

    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([
      { at: 'permissions.checks[2]', code: 'REQUIRED_UNIT_SCOPE_PERMISSION', message: expect.any(String) },
    ]);
  });

  describe('a plugin manifest that cannot be read stops the report there', () => {
    it.each([
      ['missing', undefined],
      ['not JSON', '{ "slug": '],
      ['an array', '[]'],
      ['a string', '"demo-sink"'],
    ])('%s', async (_name, text) => {
      const pluginDir = await writePluginFixture(root, { manifest: text ?? '{}' });

      if (text === undefined) {
        await unlink(join(pluginDir, 'manifest.json'));
      }

      const report = await validatePluginTree(pluginDir, OPTIONS);

      expect(report).toEqual({
        errors: [{ at: 'manifest.json', code: 'MANIFEST_UNREADABLE', message: expect.any(String) }],
        notes: [],
        warnings: [],
      });
    });

    it('reports nothing for a missing manifest.json the archive rules already reported as a required file (#1093)', async () => {
      const pluginDir = await writePluginFixture(root);
      await unlink(join(pluginDir, 'manifest.json'));

      const report = await validatePluginTree(pluginDir, OPTIONS, { missingManifestReported: true });

      expect(report).toEqual({ errors: [], notes: [], warnings: [] });
    });

    it('still reports a manifest.json that is there but not JSON, whatever the archive rules reported (#1093)', async () => {
      const pluginDir = await writePluginFixture(root, { manifest: '{ "slug": ' });

      const report = await validatePluginTree(pluginDir, OPTIONS, { missingManifestReported: true });

      expect(codes(report.errors)).toEqual(['MANIFEST_UNREADABLE']);
    });
  });

  describe('--against', () => {
    const writeAgainst = async (manifest: unknown): Promise<string> => {
      const path = join(await mkdtemp(join(root, 'against-')), 'manifest.json');
      await writeFile(path, JSON.stringify(manifest));

      return path;
    };

    it('warns for a permission newly required at household scope, and skips the skipped-comparison note', async () => {
      const base = buildPluginManifest({ bgeCompat: '>=0.0.0', scope: 'household' });
      const against = await writeAgainst(base);
      const report = await validate(
        { manifest: { permissions: { checks: [...base.permissions.checks, HOUSEHOLD_CHECK] }, scope: 'household' } },
        { against },
      );

      expect(report.errors).toEqual([]);
      expect(codes(report.warnings)).toContain('REQUIRED_UNIT_SCOPE_PERMISSION_INTRODUCED');
      expect(report.warnings).toContainEqual({
        at: 'permissions.checks[2]',
        code: 'REQUIRED_UNIT_SCOPE_PERMISSION_INTRODUCED',
        message: expect.stringContaining('read:game'),
      });
      expect(codes(report.notes)).not.toContain('CONSENT_COMPARISON_SKIPPED');
    });

    it("compares with an earlier version whose bgeCompat range the --bge-version doesn't satisfy", async () => {
      const base = buildPluginManifest({ bgeCompat: '^0.1.0', scope: 'household' });
      const against = await writeAgainst(base);
      const report = await validate(
        { manifest: { permissions: { checks: [...base.permissions.checks, HOUSEHOLD_CHECK] }, scope: 'household' } },
        { against, bgeVersion: '9.0.0' },
      );

      expect(report.errors).toEqual([]);
      expect(codes(report.warnings)).toContain('REQUIRED_UNIT_SCOPE_PERMISSION_INTRODUCED');
    });

    it('falls back to --bge-version when the earlier bgeCompat is not a string (#1093)', async () => {
      const against = await writeAgainst({ ...buildPluginManifest({ bgeCompat: '>=0.0.0' }), bgeCompat: 5 });
      const report = await validate({}, { against });

      // The fallback ran (no throw in the version lookup) and the validator
      // then judged the field itself, so the detail names bgeCompat.
      expect(report.errors).toEqual([]);
      expect(report.warnings).toContainEqual({
        at: against,
        code: 'CONSENT_COMPARISON_SKIPPED',
        message: expect.stringContaining('error at bgeCompat'),
      });
    });

    // That version is already out, so the plugin author cannot fix it; failing
    // the run would stop `build` writing a plugin artifact that is fine.
    it("warns that the comparison was skipped, without failing, when today's validator refuses the earlier version (#1093)", async () => {
      const against = await writeAgainst({
        ...buildPluginManifest({ bgeCompat: '>=0.0.0' }),
        version: 'not-a-version',
      });
      const report = await validate({}, { against });

      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([
        {
          at: against,
          code: 'CONSENT_COMPARISON_SKIPPED',
          message: expect.stringContaining("The earlier version's plugin manifest no longer passes validation"),
        },
      ]);
      expect(codes(report.notes)).not.toContain('CONSENT_COMPARISON_SKIPPED');
    });

    it('says the comparison did not run, and why, without --against', async () => {
      const report = await validate({});

      expect(report.notes).toContainEqual({
        code: 'CONSENT_COMPARISON_SKIPPED',
        message: expect.stringContaining('Pass --against'),
      });
    });

    it('says the comparison did not run when the plugin manifest has errors to fix first', async () => {
      const against = await writeAgainst(buildPluginManifest({ bgeCompat: '>=0.0.0' }));
      const report = await validate({ manifest: { version: 'not-a-version' } }, { against });

      expect(codes(report.errors)).toEqual(['VERSION_INVALID']);
      expect(report.notes).toContainEqual({
        code: 'CONSENT_COMPARISON_SKIPPED',
        message: expect.stringContaining('Fix the errors in the plugin manifest'),
      });
      expect(report.notes.find((note) => note.code === 'CONSENT_COMPARISON_SKIPPED')?.message).not.toContain(
        'Pass --against',
      );
    });

    it('reports an earlier version it cannot read as AGAINST_UNREADABLE at that path', async () => {
      const against = await writeAgainst([1, 2, 3]);
      const report = await validate({}, { against });

      expect(report.errors).toEqual([{ at: against, code: 'AGAINST_UNREADABLE', message: expect.any(String) }]);
      expect(codes(report.notes)).not.toContain('CONSENT_COMPARISON_SKIPPED');
    });
  });
});
