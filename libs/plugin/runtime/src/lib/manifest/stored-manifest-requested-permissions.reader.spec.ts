import { PluginGrantScope } from '@bge/database';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { StoredManifestRequestedPermissionsReader } from './stored-manifest-requested-permissions.reader';

describe('StoredManifestRequestedPermissionsReader (#577)', () => {
  const reader = new StoredManifestRequestedPermissionsReader({ bgeVersion: '0.0.0', defaultLocale: 'en' } as never);

  const manifest = buildPluginManifest({
    scope: 'household',
    permissions: {
      declares: ['manage:digest'],
      checks: [
        {
          slug: 'manage:digest',
          required: true,
          reason: { en: 'Stores and manages the digest configuration it owns.' },
          consentScope: 'server',
        },
        {
          slug: 'read:game:public',
          required: false,
          reason: { en: 'Reads the public catalog to compose the digest.' },
          consentScope: 'household',
        },
      ],
    },
  });

  it('maps each requested permission to its decision scope', () => {
    const result = reader.read({ slug: 'demo-sink', version: '1.2.0', manifestJson: manifest });

    expect(result).toEqual({
      valid: true,
      requested: [
        { slug: 'plugin|demo-sink|manage:digest', scopeType: PluginGrantScope.Server },
        { slug: 'read:game:public', scopeType: PluginGrantScope.Household },
      ],
    });
  });

  it('reports a manifest whose version disagrees with the row as invalid', () => {
    const result = reader.read({ slug: 'demo-sink', version: '9.9.9', manifestJson: manifest });

    expect(result).toEqual({ valid: false, detail: expect.stringContaining("'9.9.9'") });
  });

  it('reports a manifest that fails validation as invalid', () => {
    const result = reader.read({ slug: 'x', version: '1.0.0', manifestJson: { slug: 'x' } });

    // The issues themselves: the rejection already says re-validation failed.
    expect(result).toEqual({ valid: false, detail: expect.stringContaining('version') });
    expect(result).not.toEqual(expect.objectContaining({ detail: expect.stringContaining('re-validation') }));
  });
});
