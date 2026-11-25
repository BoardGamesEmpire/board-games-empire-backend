import { collectForbiddenPermissionViolations } from './forbidden-permissions.js';
import { validatePluginManifest } from './manifest-validator.js';
import { buildPluginManifest } from './testing/manifest-fixture.js';

const validate = (manifest: unknown) => validatePluginManifest(manifest, { bgeVersion: '0.3.0', defaultLocale: 'en' });

describe('collectForbiddenPermissionViolations', () => {
  it('accepts the clean fixture', () => {
    expect(collectForbiddenPermissionViolations(validate(buildPluginManifest()))).toEqual([]);
  });

  it('flags plugin-administration authority requested as a core check', () => {
    const validated = validate(
      buildPluginManifest({
        permissions: {
          declares: [],
          checks: [
            {
              slug: 'manage:plugin',
              required: true,
              reason: { en: 'Administers the plugin subsystem.' },
              consentScope: 'server',
            },
          ],
        },
      }),
    );

    expect(collectForbiddenPermissionViolations(validated)).toEqual([
      expect.objectContaining({
        permissionSlug: 'manage:plugin',
        detail: expect.stringContaining('self-escalation'),
      }),
    ]);
  });

  it('flags a declared bare slug that mimics the administration vocabulary', () => {
    const validated = validate(buildPluginManifest({ permissions: { declares: ['manage:plugin'], checks: [] } }));

    expect(collectForbiddenPermissionViolations(validated)).toEqual([
      expect.objectContaining({ detail: expect.stringContaining('mimics the plugin-administration vocabulary') }),
    ]);
  });

  it("flags a declared slug claiming the 'all' subject", () => {
    const validated = validate(buildPluginManifest({ permissions: { declares: ['manage:all'], checks: [] } }));

    expect(collectForbiddenPermissionViolations(validated)).toEqual([
      expect.objectContaining({ detail: expect.stringContaining("'all' subject") }),
    ]);
  });
});
