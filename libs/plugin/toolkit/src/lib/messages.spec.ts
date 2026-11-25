import type { StaticAnalysisFindingKind } from '@boardgamesempire/plugin-analysis';
import type { PluginArchiveRule } from '@boardgamesempire/plugin-manifest';
import type { ToolkitMessageCode } from './messages.js';
import { message, TOOLKIT_MESSAGE_CODES } from './messages.js';

/**
 * A `Record` over each union is exhaustive at typecheck: adding a rule or a
 * finding kind upstream fails the build here until it has an entry, so the
 * loops below can't drift from the types (#1093).
 */
const ARCHIVE_RULES: Record<PluginArchiveRule, true> = {
  corrupt: true,
  'entry-count': true,
  'entry-type': true,
  'extracted-size': true,
  'manifest-size': true,
  'manifest-slug': true,
  'not-gzip': true,
  'required-file': true,
  'top-level': true,
  'unsafe-path': true,
};

const FINDING_KINDS: Record<StaticAnalysisFindingKind, true> = {
  'cjs-require': true,
  'declared-dependency': true,
  'dynamic-import': true,
  'esm-import': true,
  'lockfile-package': true,
  'non-literal-import': true,
  'non-literal-require': true,
  'parse-failure': true,
  'read-failure': true,
};

const keysOf = <K extends string>(record: Record<K, true>): K[] =>
  Object.keys(record).filter((key): key is K => key in record);

/** Every placeholder name a message may use, so a filled message has none left. */
const ALL_PARAMS = { detail: 'disk full', entry: 'package/x', permission: 'manage:plugin', specifier: 'axios' };

const PLACEHOLDER = /\{[a-zA-Z]+\}/;

describe('messages (#1093)', () => {
  it("lists exactly the CLI's own report codes, so a new code needs a message before it can be used", () => {
    expect([...TOOLKIT_MESSAGE_CODES].sort()).toEqual(
      [
        'USAGE',
        'MANIFEST_UNREADABLE',
        'PLUGIN_PERMISSION_FORBIDDEN',
        'FORBIDDEN_IMPORT_ACCEPTED',
        'ACCEPTED_IMPORT_NOT_FOUND',
        'AGAINST_UNREADABLE',
        'CONSENT_COMPARISON_SKIPPED',
        'NOT_CHECKED_PERMISSION_CATALOG',
        'NOT_CHECKED_BEYOND_SCAN',
        'LOCKFILE_MISSING',
        'LOCKFILE_UNSUPPORTED',
        'PLUGIN_BUILD_FAILED',
        'NPM_PACK_FAILED',
        'DEPENDENCY_INSTALL_FAILED',
        'SYMLINK_REFUSED',
        'ARTIFACT_TOO_LARGE',
        'PLUGIN_ARTIFACT_LEFT_OUT',
        'UNEXPECTED_ERROR',
      ].sort(),
    );
  });

  const codes: readonly (ToolkitMessageCode | PluginArchiveRule | StaticAnalysisFindingKind)[] = [
    ...TOOLKIT_MESSAGE_CODES,
    ...keysOf(ARCHIVE_RULES),
    ...keysOf(FINDING_KINDS),
  ];

  it.each(codes)('has a plain-language message for %s with every placeholder filled', (code) => {
    const text = message(code, ALL_PARAMS);

    expect(text.length).toBeGreaterThan(20);
    expect(text).not.toMatch(PLACEHOLDER);
    expect(text).toMatch(/[.!?]$/);
    expect(text).not.toContain('\n');
  });

  it.each(codes)('keeps to the glossary words in the message for %s (no tarball, bundle or bare package)', (code) => {
    // Unfilled, so only the copy is judged, not a sample entry name.
    const text = message(code);

    expect(text).not.toMatch(/tarball|bundle/i);
    // package.json and package-lock.json are npm's own file names; a bare
    // "package" means the plugin artifact and must say so.
    expect(text).not.toMatch(/\bpackage\b(?![.-])/i);
  });

  it('fills a placeholder with the value it is given, quoted', () => {
    expect(message('esm-import', { specifier: 'axios' })).toContain('"axios"');
    expect(message('PLUGIN_PERMISSION_FORBIDDEN', { permission: 'manage:plugin' })).toContain('"manage:plugin"');
  });

  it('prints an entry name quoted and cut to 200 characters, as the server does, so it cannot forge report lines', () => {
    const long = message('unsafe-path', { entry: `package/${'a'.repeat(300)}` });

    expect(long).toContain(`${JSON.stringify(`package/${'a'.repeat(300)}`).slice(0, 200)}...`);
    expect(long).not.toContain('a'.repeat(200));

    const forged = message('unsafe-path', { entry: 'package/x\nerror esm-import dist/a.js: forged' });

    expect(forged).not.toContain('\n');
    expect(forged).toContain('"package/x\\nerror esm-import dist/a.js: forged"');
  });

  it('leaves a placeholder with no value visible instead of throwing while a report renders', () => {
    expect(message('unsafe-path')).toContain('{entry}');
  });

  it('names a forbidden import the scan found, in the words of a forbidden import', () => {
    expect(message('cjs-require', { specifier: 'pg' })).toMatch(/forbidden import/);
  });
});
