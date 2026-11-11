import { loadPluginUnitEnablement } from './plugin-unit-enablement';

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
      dormantReason: null,
    });
    expect(db.householdPlugin.findUnique).not.toHaveBeenCalled();
    expect(db.userPlugin.findUnique).not.toHaveBeenCalled();
  });

  it('reads the household unit enablement by its compound key, dormancy included', async () => {
    db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, dormantReason: null });

    await expect(
      loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'Household', householdId: 'hh-1' }),
    ).resolves.toEqual({ anchored: true, enabled: true, dormantReason: null });
    expect(db.householdPlugin.findUnique).toHaveBeenCalledWith({
      where: { householdId_pluginId: { householdId: 'hh-1', pluginId: 'plg_1' } },
      select: { enabled: true, dormantReason: true },
    });
  });

  it('carries the dormancy reason through, so every caller collapses the same predicate (#369)', async () => {
    db.householdPlugin.findUnique.mockResolvedValue({ enabled: true, dormantReason: 'ScopeOrphaned' });

    await expect(
      loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'Household', householdId: 'hh-1' }),
    ).resolves.toEqual({ anchored: true, enabled: true, dormantReason: 'ScopeOrphaned' });
  });

  it('reads the user unit enablement by its compound key', async () => {
    db.userPlugin.findUnique.mockResolvedValue({ enabled: true });

    await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'User', userId: 'u-1' })).resolves.toEqual({
      anchored: true,
      enabled: true,
      // The user axis has no dormancy column and no orphan state (#225).
      dormantReason: null,
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
    ).resolves.toEqual({ anchored: false, enabled: false, dormantReason: null });
  });

  it('a disabled unit enablement is still anchored (#1149)', async () => {
    db.userPlugin.findUnique.mockResolvedValue({ enabled: false });

    await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'User', userId: 'u-1' })).resolves.toEqual({
      anchored: true,
      enabled: false,
      dormantReason: null,
    });
  });

  it('fails loud on a scope type outside the union', async () => {
    await expect(loadPluginUnitEnablement(client, 'plg_1', { scopeType: 'Galaxy' } as never)).rejects.toThrow(
      RangeError,
    );
  });
});
