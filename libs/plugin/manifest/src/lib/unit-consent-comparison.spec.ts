import { ManifestWarningCode } from './errors.js';
import { validatePluginManifest } from './manifest-validator.js';
import type { PluginPermissionRequest } from './manifest.types.js';
import { buildPluginManifest } from './testing/manifest-fixture.js';
import { compareUnitConsentRequirements } from './unit-consent-comparison.js';

const check = (
  slug: string,
  required: boolean,
  consentScope: PluginPermissionRequest['consentScope'],
): PluginPermissionRequest => ({
  slug,
  required,
  reason: { en: 'Needed so the plugin can do its job for the unit.' },
  consentScope,
});

const manifestWith = (checks: PluginPermissionRequest[], version = '1.2.0') =>
  validatePluginManifest(buildPluginManifest({ scope: 'household', version, permissions: { declares: [], checks } }), {
    bgeVersion: '0.3.0',
    defaultLocale: 'en',
  });

describe('compareUnitConsentRequirements (#1093)', () => {
  it('warns on a new required household requested permission, at its index in the next manifest (#1093)', () => {
    const previous = manifestWith([check('feedback:read', true, 'server')]);
    const next = manifestWith([check('feedback:read', true, 'server'), check('game:read', true, 'household')]);

    expect(compareUnitConsentRequirements(previous, next)).toEqual([
      expect.objectContaining({
        code: ManifestWarningCode.REQUIRED_UNIT_SCOPE_PERMISSION_INTRODUCED,
        path: 'permissions.checks[1]',
      }),
    ]);
  });

  it('warns when a requested permission goes from optional to required at user scope (#1093)', () => {
    const previous = manifestWith([check('game:read', false, 'user')]);
    const next = manifestWith([check('game:read', true, 'user')]);

    expect(compareUnitConsentRequirements(previous, next)).toHaveLength(1);
  });

  it.each([
    ['server', 'household'],
    ['household', 'user'],
    ['user', 'household'],
  ] as const)('warns when a required requested permission moves from %s to %s scope (#1093)', (from, to) => {
    const previous = manifestWith([check('game:read', true, from)]);
    const next = manifestWith([check('game:read', true, to)]);

    expect(compareUnitConsentRequirements(previous, next)).toHaveLength(1);
  });

  it('stays quiet for unchanged, optional, server-scope and removed requested permissions (#1093)', () => {
    const previous = manifestWith([check('game:read', true, 'household'), check('user:read', true, 'user')]);
    const next = manifestWith([
      check('game:read', true, 'household'),
      check('list:read', false, 'household'),
      check('feedback:read', true, 'server'),
    ]);

    expect(compareUnitConsentRequirements(previous, next)).toEqual([]);
  });

  it('names the slug and scope, and says the major version was not bumped (#1093)', () => {
    const previous = manifestWith([]);
    const next = manifestWith([check('game:read', true, 'household')], '1.3.0');
    const [warning] = compareUnitConsentRequirements(previous, next);

    expect(warning?.message).toContain('game:read');
    expect(warning?.message).toContain('household');
    expect(warning?.message).toContain('major version was not bumped');
  });

  it('names a declared permission by the slug the author wrote, not its generated envelope (#1093)', () => {
    const declaring = (checks: PluginPermissionRequest[]) =>
      validatePluginManifest(
        buildPluginManifest({
          scope: 'household',
          version: '1.3.0',
          permissions: { declares: ['manage:digest'], checks },
        }),
        { bgeVersion: '0.3.0', defaultLocale: 'en' },
      );
    const previous = declaring([]);
    const next = declaring([check('manage:digest', true, 'household')]);
    const [warning] = compareUnitConsentRequirements(previous, next);

    expect(warning?.message).toContain("'manage:digest'");
    expect(warning?.message).not.toContain('plugin|');
  });

  it('says the major version was bumped when it was (#1093)', () => {
    const previous = manifestWith([]);
    const next = manifestWith([check('game:read', true, 'household')], '2.0.0');
    const [warning] = compareUnitConsentRequirements(previous, next);

    expect(warning?.message).toContain('major version was bumped');
  });
});
