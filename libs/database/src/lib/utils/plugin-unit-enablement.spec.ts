import type { PluginActiveManifest, PluginConfigVerdict } from './plugin-active-manifest-reader';
import {
  derivePluginUnitDormancy,
  isPluginServing,
  isPluginUnitServed,
  loadPluginUnitEnablement,
} from './plugin-unit-enablement';

describe('loadPluginUnitEnablement', () => {
  const db = {
    householdPlugin: { findUnique: jest.fn() },
    userPlugin: { findUnique: jest.fn() },
  };
  const client = db as unknown as Parameters<typeof loadPluginUnitEnablement>[0];

  afterEach(() => jest.clearAllMocks());

  it('Server units have no unit enablement and read anchored and enabled — no query', async () => {
    await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'Server' })).resolves.toEqual({
      anchored: true,
      enabled: true,
      retainedConfig: null,
    });
    expect(db.householdPlugin.findUnique).not.toHaveBeenCalled();
    expect(db.userPlugin.findUnique).not.toHaveBeenCalled();
  });

  it('reads the household unit enablement by its compound key, and no stored dormancy (#1151)', async () => {
    db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, config: {} });

    await expect(
      loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'Household', householdId: 'hh-1' }),
    ).resolves.toEqual({ anchored: true, enabled: true, retainedConfig: {} });
    // Dormancy is worked out from the active manifest by derivePluginUnitDormancy, so nothing reads a stored one.
    expect(db.householdPlugin.findUnique).toHaveBeenCalledWith({
      where: { householdId_pluginId: { householdId: 'hh-1', pluginId: 'plg_1' } },
      select: { enabled: true, config: true },
    });
  });

  it('reads the user unit enablement by its compound key', async () => {
    db.userPlugin.findUnique.mockResolvedValue({ enabled: true });

    await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'User', userId: 'u-1' })).resolves.toEqual({
      anchored: true,
      enabled: true,
      retainedConfig: null,
    });
    expect(db.userPlugin.findUnique).toHaveBeenCalledWith({
      where: { userId_pluginId: { userId: 'u-1', pluginId: 'plg_1' } },
      select: { enabled: true },
    });
  });

  it('a missing unit enablement is not anchored and not enabled — it IS the unit participation', async () => {
    db.householdPlugin.findUnique.mockResolvedValue(null);

    await expect(
      loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'Household', householdId: 'hh-1' }),
    ).resolves.toEqual({ anchored: false, enabled: false, retainedConfig: {} });
  });

  it('a disabled unit enablement is still anchored (#1149)', async () => {
    db.userPlugin.findUnique.mockResolvedValue({ enabled: false });

    await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'User', userId: 'u-1' })).resolves.toEqual({
      anchored: true,
      enabled: false,
      retainedConfig: null,
    });
  });

  it('fails loud on a scope type outside the union', async () => {
    await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'Galaxy' } as never)).rejects.toThrow(
      RangeError,
    );
  });

  describe('the document the dormancy rule judges (#1151)', () => {
    const household = { scopeType: 'Household', householdId: 'hh-1' } as const;

    it('returns a household unit enablement config as its retained config', async () => {
      db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, config: { webhookUrl: 'https://x.test' } });

      await expect(loadPluginUnitEnablement(client, 'plg_1', household)).resolves.toEqual(
        expect.objectContaining({ retainedConfig: { webhookUrl: 'https://x.test' } }),
      );
      expect(db.householdPlugin.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ config: true }) }),
      );
    });

    it('returns a stored JSON null as itself, not as an empty document, so the rule can reject it', async () => {
      db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, config: null });

      await expect(loadPluginUnitEnablement(client, 'plg_1', household)).resolves.toEqual(
        expect.objectContaining({ retainedConfig: null }),
      );
    });

    it('returns an empty document for a household with no unit enablement', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null);

      await expect(loadPluginUnitEnablement(client, 'plg_1', household)).resolves.toEqual(
        expect.objectContaining({ retainedConfig: {} }),
      );
    });

    it('returns null for Server and User units, whose configuration the rule never judges', async () => {
      db.userPlugin.findUnique.mockResolvedValue({ enabled: true });

      await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'Server' })).resolves.toEqual(
        expect.objectContaining({ retainedConfig: null }),
      );
      await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'User', userId: 'u-1' })).resolves.toEqual(
        expect.objectContaining({ retainedConfig: null }),
      );
    });
  });
});

describe('derivePluginUnitDormancy (#1151)', () => {
  const manifestJudging = (
    verdict: PluginConfigVerdict,
    householdSurface = true,
  ): PluginActiveManifest & { judgeConfig: jest.Mock<PluginConfigVerdict, [unknown]> } => ({
    requested: [],
    householdSurface,
    judgeConfig: jest.fn<PluginConfigVerdict, [unknown]>().mockReturnValue(verdict),
  });

  it.each(['Server', 'Household', 'User'] as const)(
    'reads unavailable for a %s unit when the stored manifest cannot be read',
    (scopeType) => {
      expect(derivePluginUnitDormancy({ scopeType, manifest: null, retainedConfig: {} })).toBe('unavailable');
    },
  );

  it('reads unavailable for a household when the manifest has no household surface', () => {
    const manifest = manifestJudging('conforms', false);

    expect(derivePluginUnitDormancy({ scopeType: 'Household', manifest, retainedConfig: {} })).toBe('unavailable');
    // A server-scope plugin's schema is never compiled for a household.
    expect(manifest.judgeConfig).not.toHaveBeenCalled();
  });

  it('reads unavailable for a household when the config schema cannot be used', () => {
    expect(
      derivePluginUnitDormancy({
        scopeType: 'Household',
        manifest: manifestJudging('schema-unusable'),
        retainedConfig: {},
      }),
    ).toBe('unavailable');
  });

  it('reads needs_configuration for a household whose document the schema rejects', () => {
    const manifest = manifestJudging('rejected');

    expect(derivePluginUnitDormancy({ scopeType: 'Household', manifest, retainedConfig: { webhookUrl: 42 } })).toBe(
      'needs_configuration',
    );
    expect(manifest.judgeConfig).toHaveBeenCalledWith({ webhookUrl: 42 });
  });

  it('reads null for a household whose document conforms', () => {
    expect(
      derivePluginUnitDormancy({ scopeType: 'Household', manifest: manifestJudging('conforms'), retainedConfig: {} }),
    ).toBeNull();
  });

  it("never judges a Server or User unit's configuration (#697, #228)", () => {
    const manifest = manifestJudging('rejected', false);

    expect(derivePluginUnitDormancy({ scopeType: 'Server', manifest, retainedConfig: null })).toBeNull();
    expect(derivePluginUnitDormancy({ scopeType: 'User', manifest, retainedConfig: null })).toBeNull();
    expect(manifest.judgeConfig).not.toHaveBeenCalled();
  });

  it('fails loud on a scope type outside the union', () => {
    expect(() =>
      derivePluginUnitDormancy({
        scopeType: 'Galaxy' as never,
        manifest: manifestJudging('conforms'),
        retainedConfig: {},
      }),
    ).toThrow(RangeError);
  });
});

describe('the serving predicate (#772)', () => {
  // The plugin ability read and the permission catalog's consent count share
  // these, so the two cannot disagree on what serves.
  it('serves a plugin that is enabled and not uninstalled, and no other', () => {
    expect(isPluginServing({ enabled: true, uninstalledAt: null })).toBe(true);
    expect(isPluginServing({ enabled: false, uninstalledAt: null })).toBe(false);
    expect(isPluginServing({ enabled: true, uninstalledAt: new Date('2026-11-01T00:00:00.000Z') })).toBe(false);
  });

  it('serves a unit that is switched on and that the dormancy rule finds no dormancy in, and no other (#1151)', () => {
    expect(isPluginUnitServed({ enabled: true }, null)).toBe(true);
    expect(isPluginUnitServed({ enabled: false }, null)).toBe(false);
    expect(isPluginUnitServed({ enabled: true }, 'unavailable')).toBe(false);
    expect(isPluginUnitServed({ enabled: true }, 'needs_configuration')).toBe(false);
  });
});
