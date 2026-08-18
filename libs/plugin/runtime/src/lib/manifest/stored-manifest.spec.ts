import { buildPluginManifest, type ManifestIssue } from '@boardgamesempire/plugin-manifest';
import { revalidateStoredManifest, type StoredManifestRow } from './stored-manifest';

class TestManifestError extends Error {
  override readonly name = 'TestManifestError';

  constructor(
    public readonly pluginSlug: string,
    public readonly detail: string,
    public readonly issues?: readonly ManifestIssue[],
  ) {
    super(`${pluginSlug}: ${detail}`);
  }
}

describe('revalidateStoredManifest', () => {
  const options = { bgeVersion: '0.3.0', defaultLocale: 'en' };
  const factory = (pluginSlug: string, detail: string, issues?: readonly ManifestIssue[]) =>
    new TestManifestError(pluginSlug, detail, issues);

  const row = (overrides: Partial<StoredManifestRow> = {}): StoredManifestRow => ({
    slug: 'demo-sink',
    version: '1.2.0',
    manifestJson: buildPluginManifest(),
    ...overrides,
  });

  it('returns the validated result for an agreeing row', () => {
    const validated = revalidateStoredManifest(row(), options, factory);

    expect(validated.manifest.slug).toBe('demo-sink');
    expect(validated.permissionChecks.map((check) => check.canonicalSlug)).toContain('plugin|demo-sink|manage:digest');
  });

  it('does not enforce bgeCompat — a BGE upgrade past the range must not make stored state unreadable', () => {
    const manifest = buildPluginManifest({ bgeCompat: '>=99.0.0' });

    expect(() => revalidateStoredManifest(row({ manifestJson: manifest }), options, factory)).not.toThrow();
  });

  it('wraps a structurally invalid manifest in the SURFACE error, carrying the validation issues', () => {
    const build = () => revalidateStoredManifest(row({ manifestJson: { nonsense: true } }), options, factory);

    expect(build).toThrow(TestManifestError);
    expect(build).toThrow(
      expect.objectContaining({
        pluginSlug: 'demo-sink',
        detail: 'stored manifest failed re-validation',
        issues: expect.arrayContaining([expect.anything()]),
      }),
    );
  });

  it('rejects a manifest whose slug drifted from the row — canonical slugs would resolve against another catalog', () => {
    const build = () => revalidateStoredManifest(row({ slug: 'other-plugin' }), options, factory);

    expect(build).toThrow(TestManifestError);
    expect(build).toThrow(
      expect.objectContaining({ detail: expect.stringContaining('does not match the plugin row') }),
    );
  });

  it('rejects a manifest whose version drifted from the row', () => {
    const build = () => revalidateStoredManifest(row({ version: '9.9.9' }), options, factory);

    expect(build).toThrow(TestManifestError);
    expect(build).toThrow(
      expect.objectContaining({ detail: expect.stringContaining("does not match the plugin row's '9.9.9'") }),
    );
  });
});
