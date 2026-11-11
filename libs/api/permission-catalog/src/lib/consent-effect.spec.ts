import {
  Action,
  PluginGrantScope,
  PluginGrantStatus,
  PluginUnitDormantReason,
  ResourceType,
  RiskLevel,
  type Prisma,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import {
  countConsentDecisionsLost,
  loadConsentDecisionsInForce,
  type ConsentDecision,
  type ConsentEffectColumns,
} from './consent-effect';

/** A permission on events bound to the consenting household, as a plugin's household consent needs (#591). */
const householdBound = (overrides: Partial<ConsentEffectColumns> = {}): ConsentEffectColumns => ({
  slug: 'update:event:plugin-fixture',
  action: Action.update,
  subject: ResourceType.Event,
  fields: [],
  inverted: false,
  conditions: { householdId: '{{ unit.householdId }}' },
  riskLevel: RiskLevel.Medium,
  retiredAt: null,
  ...overrides,
});

const decision = (
  scopeType: PluginGrantScope,
  decidedRiskLevel: RiskLevel,
  status: PluginGrantStatus = PluginGrantStatus.Granted,
): ConsentDecision => ({ scopeType, decidedRiskLevel, status });

describe('countConsentDecisionsLost (#772)', () => {
  it('counts a decision decided at Medium when the risk level rises to High, and not one decided at High', () => {
    const before = householdBound({ riskLevel: RiskLevel.Medium });
    const after = householdBound({ riskLevel: RiskLevel.High });

    expect(
      countConsentDecisionsLost(before, after, [
        decision(PluginGrantScope.Server, RiskLevel.Medium),
        decision(PluginGrantScope.Household, RiskLevel.Medium),
        decision(PluginGrantScope.Household, RiskLevel.High),
      ]),
    ).toBe(2);
  });

  it("counts a household decision, not a server one, when the condition stops naming the household's own id", () => {
    const before = householdBound();
    // The role pass's household, which no plugin unit supplies: nothing binds the
    // consenting household any more, but server consent is server-wide anyway.
    const after = householdBound({ conditions: { householdId: '{{ householdId }}' } });

    expect(
      countConsentDecisionsLost(before, after, [
        decision(PluginGrantScope.Household, RiskLevel.Medium),
        decision(PluginGrantScope.Server, RiskLevel.Medium),
      ]),
    ).toBe(1);
  });

  it('counts none when the risk level is lowered', () => {
    const before = householdBound({ riskLevel: RiskLevel.High });
    const after = householdBound({ riskLevel: RiskLevel.Medium });

    expect(
      countConsentDecisionsLost(before, after, [
        decision(PluginGrantScope.Household, RiskLevel.Medium),
        decision(PluginGrantScope.Server, RiskLevel.High),
      ]),
    ).toBe(0);
  });

  it('never counts a denial, which conferred nothing to lose', () => {
    expect(
      countConsentDecisionsLost(householdBound(), householdBound({ riskLevel: RiskLevel.Critical }), [
        decision(PluginGrantScope.Server, RiskLevel.Low, PluginGrantStatus.Denied),
      ]),
    ).toBe(0);
  });

  it('counts every conferring decision when the permission is retired, since a retired permission confers nothing', () => {
    const after = householdBound({ retiredAt: new Date('2026-11-08T00:00:00.000Z') });

    expect(
      countConsentDecisionsLost(householdBound(), after, [
        decision(PluginGrantScope.Server, RiskLevel.Medium),
        decision(PluginGrantScope.Household, RiskLevel.Medium),
        // Already short of the risk level, so it was conferring nothing before.
        decision(PluginGrantScope.Household, RiskLevel.Low),
      ]),
    ).toBe(2);
  });

  it('counts none when a retired permission is revived', () => {
    const before = householdBound({ retiredAt: new Date('2026-11-08T00:00:00.000Z') });

    expect(
      countConsentDecisionsLost(before, householdBound(), [decision(PluginGrantScope.Household, RiskLevel.Medium)]),
    ).toBe(0);
  });
});

/**
 * Which stored decisions are in force today, by the rules the plugin ability
 * read applies before it looks at the permission (#772): the plugin served,
 * the unit served, the active manifest requesting it.
 */
describe('loadConsentDecisionsInForce (#772)', () => {
  const SLUG = 'read:game:public';
  let db: MockDatabaseService;
  const reader = { read: jest.fn() };

  const stored = (overrides: Record<string, unknown> = {}) => ({
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Server,
    scopeId: '',
    decidedRiskLevel: RiskLevel.Low,
    status: PluginGrantStatus.Granted,
    plugin: { slug: 'tabletop-sync', version: '1.0.0', manifestJson: {}, enabled: true, uninstalledAt: null },
    ...overrides,
  });

  const requestedAt = (...scopes: PluginGrantScope[]) => ({
    valid: true,
    requested: scopes.map((scopeType) => ({ slug: SLUG, scopeType })),
  });

  // The mock carries every delegate the loader reads; its jest types are not Prisma's.
  const tx = () => db as unknown as Prisma.TransactionClient;
  const inForce = () => loadConsentDecisionsInForce(tx(), SLUG, reader);

  beforeEach(() => {
    db = createMockDatabaseService();
    reader.read.mockReset().mockReturnValue(requestedAt(...Object.values(PluginGrantScope)));
    db.householdPlugin.findMany.mockResolvedValue([]);
    db.userPlugin.findMany.mockResolvedValue([]);
  });

  it('reads the Granted decisions on the slug', async () => {
    db.pluginGrant.findMany.mockResolvedValue([]);

    await expect(inForce()).resolves.toEqual([]);
    expect(db.pluginGrant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { permissionSlug: SLUG, status: PluginGrantStatus.Granted } }),
    );
  });

  it('keeps a server decision of an enabled, installed plugin whose manifest requests it, and reads that manifest as stored', async () => {
    db.pluginGrant.findMany.mockResolvedValue([stored()] as never);

    await expect(inForce()).resolves.toEqual([
      { scopeType: PluginGrantScope.Server, decidedRiskLevel: RiskLevel.Low, status: PluginGrantStatus.Granted },
    ]);
    expect(reader.read).toHaveBeenCalledWith({ slug: 'tabletop-sync', version: '1.0.0', manifestJson: {} });
  });

  it('drops a decision of a disabled plugin, and one of an uninstalled plugin', async () => {
    db.pluginGrant.findMany.mockResolvedValue([
      stored({ plugin: { ...stored().plugin, enabled: false } }),
      stored({ pluginId: 'plugin-2', plugin: { ...stored().plugin, uninstalledAt: new Date('2026-11-01') } }),
    ] as never);

    await expect(inForce()).resolves.toEqual([]);
  });

  it('drops a decision the active manifest does not request at its scope', async () => {
    reader.read.mockReturnValue(requestedAt(PluginGrantScope.Household));
    db.pluginGrant.findMany.mockResolvedValue([stored()] as never);

    await expect(inForce()).resolves.toEqual([]);
  });

  it('drops every decision of a plugin whose stored manifest fails re-validation, as the read rejects its ability', async () => {
    reader.read.mockReturnValue({ valid: false, detail: 'manifest.permissions[0]: unknown scope' });
    db.pluginGrant.findMany.mockResolvedValue([stored()] as never);

    await expect(inForce()).resolves.toEqual([]);
  });

  it('counts nothing in force in a process that registers no manifest reader, where no decision confers', async () => {
    db.pluginGrant.findMany.mockResolvedValue([stored()] as never);

    await expect(loadConsentDecisionsInForce(tx(), SLUG, undefined)).resolves.toEqual([]);
  });

  it("keeps a household decision only while the household's enablement row serves the plugin", async () => {
    const household = (householdId: string) => stored({ scopeType: PluginGrantScope.Household, scopeId: householdId });
    db.pluginGrant.findMany.mockResolvedValue(['served', 'disabled', 'dormant', 'no-row'].map(household) as never);
    const row = (householdId: string, overrides: Record<string, unknown> = {}) => ({
      householdId,
      pluginId: 'plugin-1',
      enabled: true,
      dormantReason: null,
      ...overrides,
    });
    db.householdPlugin.findMany.mockResolvedValue([
      row('served'),
      row('disabled', { enabled: false }),
      row('dormant', { dormantReason: PluginUnitDormantReason.ScopeOrphaned }),
    ] as never);

    const kept = await inForce();

    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ scopeType: PluginGrantScope.Household });
    expect(db.householdPlugin.findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps a user decision only while the user's enablement row serves the plugin", async () => {
    const user = (userId: string) => stored({ scopeType: PluginGrantScope.User, scopeId: userId });
    db.pluginGrant.findMany.mockResolvedValue(['served', 'disabled', 'no-row'].map(user) as never);
    db.userPlugin.findMany.mockResolvedValue([
      { userId: 'served', pluginId: 'plugin-1', enabled: true },
      { userId: 'disabled', pluginId: 'plugin-1', enabled: false },
    ] as never);

    const kept = await inForce();

    expect(kept).toEqual([
      { scopeType: PluginGrantScope.User, decidedRiskLevel: RiskLevel.Low, status: PluginGrantStatus.Granted },
    ]);
  });

  it("does not take one plugin's enablement row for another's", async () => {
    db.pluginGrant.findMany.mockResolvedValue([
      stored({ pluginId: 'plugin-2', scopeType: PluginGrantScope.Household, scopeId: 'h1' }),
    ] as never);
    db.householdPlugin.findMany.mockResolvedValue([
      { householdId: 'h1', pluginId: 'plugin-1', enabled: true, dormantReason: null },
    ] as never);

    await expect(inForce()).resolves.toEqual([]);
  });
});
