import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { INVENTORY_STAGING_ID, pluginRowData, stagedUpdateColumns } from './plugin-row-fixtures';

describe('plugin row fixtures', () => {
  // A fixture that left one of the five required columns unset would make
  // every spec using it trip the check constraint. The artifact's link and
  // registry sit outside that set and are null by default, as for an upload
  // (#1096).
  it('stagedUpdateColumns sets the five columns the staged-update CHECK requires, and no link or registry by default (#1118, #1096)', () => {
    const columns = stagedUpdateColumns();
    const required = [
      'pendingManifestJson',
      'pendingSince',
      'pendingSha256',
      'pendingStagingId',
      'pendingVersion',
    ] as const;
    const provenance = ['pendingFromUrl', 'pendingRegistrySlug'] as const;

    expect(Object.keys(columns).sort()).toEqual([...required, ...provenance].sort());

    for (const key of required) {
      expect(columns[key]).not.toBeNull();
      expect(columns[key]).not.toBeUndefined();
    }

    for (const key of provenance) {
      expect(columns).toHaveProperty(key, null);
    }

    expect(columns.pendingStagingId).toBe(INVENTORY_STAGING_ID);
  });

  it('stagedUpdateColumns takes a link and a registry (#1096)', () => {
    const columns = stagedUpdateColumns({ url: 'https://plugins.example.test/demo-sink.tgz', registrySlug: 'example' });

    expect(columns.pendingFromUrl).toBe('https://plugins.example.test/demo-sink.tgz');
    expect(columns.pendingRegistrySlug).toBe('example');
  });

  it('stagedUpdateColumns takes the version from a given manifest (#1118)', () => {
    const manifest = { ...buildPluginManifest(), version: '2.4.0' };

    expect(stagedUpdateColumns({ manifest }).pendingVersion).toBe('2.4.0');
  });

  it('pluginRowData is an installed, disabled row (#1118)', () => {
    const row = pluginRowData();

    expect(row.enabled).toBe(false);
    expect(row.installedSha256).toBe('a'.repeat(64));
    expect(row.pendingVersion).toBeUndefined();
  });

  it('pluginRowData lets an override win (#1118)', () => {
    expect(pluginRowData({ slug: 'demo-sink', enabled: true })).toMatchObject({ slug: 'demo-sink', enabled: true });
  });
});
