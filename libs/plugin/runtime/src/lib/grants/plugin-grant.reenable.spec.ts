import {
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  Prisma,
  RiskLevel,
  type HouseholdPlugin,
  type Permission,
  type Plugin,
  type PluginGrant,
  type UserPlugin,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { HouseholdPluginUnitEnabledEvent, UserPluginUnitEnabledEvent } from '../events/plugin.events';
import type { PluginGrantAuthorityService } from './plugin-grant-authority.service';
import { PluginGrantService, type PluginGrantDecisionInput } from './plugin-grant.service';

/**
 * Late acceptance: `decide()` clears `suspendedForConsent` and emits
 * `plugin.unit_enabled` once a unit's `Granted` decision covers every
 * required-at-scope permission of the active manifest — for household AND
 * user units (#225). Focused here rather than folded into the main decide()
 * spec — the post-effect has its own matrix. The household block carries
 * the full predicate matrix; the user block asserts the mirrored transition
 * and the one behavior unique to that scope.
 */
describe('PluginGrantService — late-acceptance re-enable post-effect', () => {
  // The fixture's household-required surface: calendar:read (required) plus
  // the baseline server checks the post-effect must ignore.
  const manifest = buildPluginManifest({
    scope: 'household',
    permissions: {
      declares: ['manage:digest'],
      checks: [
        ...buildPluginManifest().permissions.checks,
        {
          slug: 'calendar:read',
          required: true,
          reason: { en: 'Schedules digests around household events.' },
          consentScope: 'household',
        },
        {
          slug: 'notify:send',
          required: false,
          reason: { en: 'Optional notifications.' },
          consentScope: 'household',
        },
        {
          slug: 'read:user_digest',
          required: true,
          reason: { en: 'Reads the digest each member curated for themselves.' },
          consentScope: 'user',
        },
      ],
    },
  });

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    executionMode: PluginExecutionMode.InProcess,
    enabled: true,
    bundled: false,
    manifestJson: manifest as unknown as Prisma.JsonValue,
    config: {},
    loadFailed: false,
    loadError: null,
    installedById: null,
    installedAt: new Date(0),
    updateCheckEnabled: false,
    lastUpdateCheckAt: null,
    latestKnownVersion: null,
    latestKnownChannel: null,
    securityAdvisory: null,
    installedFromUrl: null,
    installedSha256: 'sha',
    registrySlug: null,
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makeGrant = (overrides: Partial<PluginGrant> = {}): PluginGrant => ({
    id: 'grant-1',
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Household,
    scopeId: 'household-1',
    permissionSlug: 'calendar:read',
    status: PluginGrantStatus.Granted,
    decidedById: 'owner-1',
    manifestVersion: '1.2.0',
    decidedRiskLevel: RiskLevel.Low,
    decidedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makeUnit = (overrides: Partial<HouseholdPlugin> = {}): HouseholdPlugin => ({
    id: 'hp-1',
    householdId: 'household-1',
    pluginId: 'plugin-1',
    enabled: true,
    config: {},
    suspendedForConsent: true,
    suspendedAt: new Date('2026-07-29T00:00:00Z'),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  // Bounding clauses so unit-scope decisions pass the unit-boundedness gate
  // (#60); the condition-free refusal is specced in the main service suite.
  const calendarRead = {
    slug: 'calendar:read',
    subject: 'calendar',
    riskLevel: RiskLevel.Low,
    conditions: { householdId: '{{ unit.householdId }}' },
  } as unknown as Permission;

  /**
   * The re-enable predicate reads `select: { slug, riskLevel }`, but the
   * delegate mock is typed against the full row — so the projection is
   * asserted, matching how `calendarRead` above is built.
   */
  const corePermission = (slug: string, riskLevel: RiskLevel): Permission =>
    ({ slug, riskLevel, conditions: { householdId: '{{ unit.householdId }}' } }) as unknown as Permission;

  let db: MockDatabaseService;
  let emitter: { emit: jest.Mock };
  let service: PluginGrantService;

  const decision = (overrides: Partial<PluginGrantDecisionInput> = {}): PluginGrantDecisionInput => ({
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Household,
    scopeId: 'household-1',
    permissionSlug: 'calendar:read',
    status: PluginGrantStatus.Granted,
    deciderId: 'owner-1',
    ...overrides,
  });

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    db = createMockDatabaseService();
    const authority = {
      isServerAdmin: jest.fn().mockResolvedValue(false),
      isHouseholdAdmin: jest.fn().mockResolvedValue(true),
    } satisfies Partial<jest.Mocked<PluginGrantAuthorityService>>;
    emitter = { emit: jest.fn() };
    service = new PluginGrantService(
      db as never,
      authority as unknown as PluginGrantAuthorityService,
      emitter as never,
      {
        pluginsRoot: '/var/lib/bge/plugins',
        bundledRoot: '/srv/bge/plugins/bundled',
        bgeVersion: '0.3.0',
        defaultLocale: 'en',
      },
    );

    db.plugin.findUnique.mockResolvedValue(makePlugin());
    db.permission.findUnique.mockResolvedValue(calendarRead);
    // The re-enable predicate reads TODAY's catalog risk for core
    // household-scope checks so a stale decision cannot clear a suspension.
    db.permission.findMany.mockResolvedValue([
      corePermission('calendar:read', RiskLevel.Low),
      corePermission('notify:send', RiskLevel.Low),
    ]);
    db.pluginGrant.findUnique.mockResolvedValue(null);
    db.pluginGrant.upsert.mockResolvedValue(makeGrant());
    db.householdPlugin.findUnique.mockResolvedValue(makeUnit());
    db.pluginGrant.findMany.mockResolvedValue([makeGrant()]);
    db.householdPlugin.updateMany.mockResolvedValue({ count: 1 });
    db.$transaction.mockImplementation((cb) => cb(db));
  });

  afterEach(() => jest.clearAllMocks());

  it('clears the suspension and emits unit_enabled when the decision covers the last outstanding required slug', async () => {
    await service.decide(decision());

    expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
      where: { id: 'hp-1', suspendedForConsent: true },
      data: { suspendedForConsent: false, suspendedAt: null },
    });
    expect(emitter.emit).toHaveBeenCalledWith(
      HouseholdPluginUnitEnabledEvent.eventName,
      expect.objectContaining({
        grantedPermissionSlug: 'calendar:read',
        manifestVersion: '1.2.0',
        before: expect.objectContaining({ suspendedForConsent: true }),
        after: expect.objectContaining({ suspendedForConsent: false }),
      }),
    );
  });

  it('leaves the suspension in place while required slugs remain outstanding', async () => {
    db.pluginGrant.findMany.mockResolvedValue([]);

    await service.decide(decision());

    expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitEnabledEvent.eventName, expect.anything());
  });

  it('leaves the suspension in place when a granted slug no longer covers the catalog risk', async () => {
    // notify:send is OPTIONAL and already granted — at Low, while the catalog
    // now says High. Presence of that row is not consent at today's risk, so
    // clearing the suspension here would undo the update's own escalation.
    db.pluginGrant.findMany.mockResolvedValue([
      makeGrant(),
      makeGrant({ id: 'grant-2', permissionSlug: 'notify:send', decidedRiskLevel: RiskLevel.Low }),
    ]);
    db.permission.findMany.mockResolvedValue([
      corePermission('calendar:read', RiskLevel.Low),
      corePermission('notify:send', RiskLevel.High),
    ]);

    await service.decide(decision());

    expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitEnabledEvent.eventName, expect.anything());
  });

  it('does nothing for a unit that is not suspended', async () => {
    db.householdPlugin.findUnique.mockResolvedValue(makeUnit({ suspendedForConsent: false, suspendedAt: null }));

    await service.decide(decision());

    expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
  });

  it('does not run the check for a Denied decision', async () => {
    db.pluginGrant.upsert.mockResolvedValue(makeGrant({ status: PluginGrantStatus.Denied }));

    await service.decide(decision({ status: PluginGrantStatus.Denied }));

    expect(db.householdPlugin.findUnique).not.toHaveBeenCalled();
  });

  it('does not run the check for an unchanged (idempotent) decision', async () => {
    db.pluginGrant.findUnique.mockResolvedValue(makeGrant());

    await service.decide(decision());

    expect(db.householdPlugin.findUnique).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('does not emit when a concurrent writer already cleared the suspension (guarded updateMany)', async () => {
    db.householdPlugin.updateMany.mockResolvedValue({ count: 0 });

    await service.decide(decision());

    expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitEnabledEvent.eventName, expect.anything());
  });

  it('never fails the committed decision when the re-enable check errors — logged, not thrown', async () => {
    db.householdPlugin.findUnique.mockRejectedValue(new Error('connection reset'));

    await expect(service.decide(decision())).resolves.toMatchObject({ changed: true });
  });

  /**
   * The user-scope mirror (#225). The covering predicate is the same
   * scope-parametric method the household matrix above exercises, so these
   * assert the mirrored transition, the guarded write, and the scope's own
   * wrinkle — the decision's in-transaction row ensure never clears a
   * suspension.
   */
  describe('user scope', () => {
    const userGrant = (overrides: Partial<PluginGrant> = {}): PluginGrant =>
      makeGrant({
        id: 'grant-u1',
        scopeType: PluginGrantScope.User,
        scopeId: 'user-1',
        permissionSlug: 'read:user_digest',
        ...overrides,
      });

    const makeUserUnit = (overrides: Partial<UserPlugin> = {}): UserPlugin => ({
      id: 'up-1',
      userId: 'user-1',
      pluginId: 'plugin-1',
      enabled: true,
      config: {},
      suspendedForConsent: true,
      suspendedAt: new Date('2026-07-29T00:00:00Z'),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...overrides,
    });

    const userDecision = (): PluginGrantDecisionInput =>
      decision({
        scopeType: PluginGrantScope.User,
        scopeId: 'user-1',
        deciderId: 'user-1',
        permissionSlug: 'read:user_digest',
      });

    beforeEach(() => {
      db.permission.findUnique.mockResolvedValue(corePermission('read:user_digest', RiskLevel.Low));
      db.permission.findMany.mockResolvedValue([corePermission('read:user_digest', RiskLevel.Low)]);
      db.pluginGrant.upsert.mockResolvedValue(userGrant());
      db.pluginGrant.findMany.mockResolvedValue([userGrant()]);
      db.userPlugin.findUnique.mockResolvedValue(makeUserUnit());
      db.userPlugin.updateMany.mockResolvedValue({ count: 1 });
    });

    it('clears the suspension and emits unit_enabled when the decision covers the last outstanding required slug', async () => {
      await service.decide(userDecision());

      expect(db.userPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'up-1', suspendedForConsent: true },
        data: { suspendedForConsent: false, suspendedAt: null },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        UserPluginUnitEnabledEvent.eventName,
        expect.objectContaining({
          grantedPermissionSlug: 'read:user_digest',
          manifestVersion: '1.2.0',
          before: expect.objectContaining({ suspendedForConsent: true, userId: 'user-1' }),
          after: expect.objectContaining({ suspendedForConsent: false }),
        }),
      );
    });

    it('the in-transaction row ensure does not clear the suspension — only the late-acceptance predicate may', async () => {
      await service.decide(userDecision());

      // The ensure runs with an EMPTY update arm; the only suspension write
      // is the guarded late-acceptance clear asserted above.
      expect(db.userPlugin.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    });

    it('leaves the suspension in place while a required user slug remains outstanding', async () => {
      db.pluginGrant.findMany.mockResolvedValue([]);

      await service.decide(userDecision());

      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(UserPluginUnitEnabledEvent.eventName, expect.anything());
    });

    it('leaves the suspension in place when a granted slug no longer covers the catalog risk', async () => {
      db.pluginGrant.findMany.mockResolvedValue([userGrant({ decidedRiskLevel: RiskLevel.Low })]);
      db.permission.findMany.mockResolvedValue([corePermission('read:user_digest', RiskLevel.High)]);

      await service.decide(userDecision());

      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('does nothing for a unit that is not suspended', async () => {
      db.userPlugin.findUnique.mockResolvedValue(makeUserUnit({ suspendedForConsent: false, suspendedAt: null }));

      await service.decide(userDecision());

      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('does not emit when a concurrent writer already cleared the suspension (guarded updateMany)', async () => {
      db.userPlugin.updateMany.mockResolvedValue({ count: 0 });

      await service.decide(userDecision());

      expect(emitter.emit).not.toHaveBeenCalledWith(UserPluginUnitEnabledEvent.eventName, expect.anything());
    });

    it('never fails the committed decision when the re-enable check errors — logged, not thrown', async () => {
      db.userPlugin.findUnique.mockRejectedValue(new Error('connection reset'));

      await expect(service.decide(userDecision())).resolves.toMatchObject({ changed: true });
    });
  });
});
