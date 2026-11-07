import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { INVENTORY_STAGING_ID, pluginRowData, stagedUpdateColumns } from './plugin-row-fixtures';

describe('plugin row fixtures', () => {
  it('stagedUpdateColumns sets all five columns the staged-update CHECK requires (#1118)', () => {
    const columns = stagedUpdateColumns();

    expect(Object.keys(columns).sort()).toEqual(
      ['pendingManifestJson', 'pendingSince', 'pendingSha256', 'pendingStagingId', 'pendingVersion'].sort(),
    );
    for (const value of Object.values(columns)) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
    }
    expect(columns.pendingStagingId).toBe(INVENTORY_STAGING_ID);
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
