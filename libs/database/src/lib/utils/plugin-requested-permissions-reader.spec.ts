import { PluginGrantScope } from '../client';
import { requestedByManifest } from './plugin-requested-permissions-reader';

describe('requestedByManifest (#577, #772)', () => {
  // The manifest bound the plugin ability read applies, shared with the
  // permission catalog's consent count so the two cannot disagree.
  const requested = requestedByManifest([
    { slug: 'read:game:public', scopeType: PluginGrantScope.Household },
    { slug: 'update:game:own', scopeType: PluginGrantScope.Server },
  ]);

  it('keeps a decision on a permission the manifest requests at that scope', () => {
    expect(requested({ permissionSlug: 'read:game:public', scopeType: PluginGrantScope.Household })).toBe(true);
    expect(requested({ permissionSlug: 'update:game:own', scopeType: PluginGrantScope.Server })).toBe(true);
  });

  it('drops one the manifest requests only at another scope, and one it does not request', () => {
    expect(requested({ permissionSlug: 'read:game:public', scopeType: PluginGrantScope.Server })).toBe(false);
    expect(requested({ permissionSlug: 'delete:game:own', scopeType: PluginGrantScope.Server })).toBe(false);
  });
});
