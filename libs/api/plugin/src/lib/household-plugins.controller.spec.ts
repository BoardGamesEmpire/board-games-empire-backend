import type { AuditContextService } from '@bge/actor-context';
import { Action, PluginGrantScope, PluginGrantStatus, ResourceType } from '@bge/database';
import { CHECK_POLICIES_KEY, type AppAbility } from '@bge/permissions';
import type {
  PluginConsentPresentation,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginFeatureUnitState,
  PluginGrantService,
  PluginInventoryService,
  PluginUnitLifecycleService,
} from '@bge/plugin';
import { createMockAbilityService, MOCK_ACTING_USER_ID, type MockAbilityService } from '@bge/testing';
import { ForbiddenException, RequestMethod } from '@nestjs/common';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { HouseholdPluginsController } from './household-plugins.controller';

const PRESENTATION = {
  plugin: { id: 'plugin-1', slug: 'demo-sink', enabled: true },
  manifestVersion: '1.2.0',
  source: 'active',
  checks: [],
} as unknown as PluginConsentPresentation;
const GRANT = { id: 'grant-1', permissionSlug: 'update:calendar', status: PluginGrantStatus.Granted } as never;
const UNIT_ROW = { id: 'hp-1', householdId: 'hh-1', pluginId: 'plugin-1', enabled: true } as never;
const INVENTORY_PAGE = {
  rows: [{ id: 'plugin-1', slug: 'demo-sink', serverEnabled: true, unit: { anchored: false }, dormantReason: null }],
  total: 1,
};
const FEATURE_STATE = {
  plugin: { id: 'plugin-1', slug: 'demo-sink' },
  unit: { scopeType: 'Household', householdId: 'hh-1' },
  served: true,
  suspendedForConsent: false,
  features: [],
} as unknown as PluginFeatureUnitState;

describe('HouseholdPluginsController (delegation + household instance gate)', () => {
  let controller: HouseholdPluginsController;
  let grants: jest.Mocked<Pick<PluginGrantService, 'decide'>>;
  let presentation: jest.Mocked<Pick<PluginConsentPresentationService, 'presentForUnitBySlug'>>;
  let units: jest.Mocked<
    Pick<PluginUnitLifecycleService, 'enableHousehold' | 'disableHousehold' | 'updateHouseholdConfig'>
  >;
  let featureState: jest.Mocked<Pick<PluginFeatureStateService, 'resolveForUnitBySlug'>>;
  let inventory: jest.Mocked<Pick<PluginInventoryService, 'listForHousehold'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale'>>;
  let abilityService: MockAbilityService;
  let can: jest.Mock;

  beforeEach(() => {
    grants = { decide: jest.fn().mockResolvedValue({ grant: GRANT, changed: true }) };
    presentation = { presentForUnitBySlug: jest.fn().mockResolvedValue(PRESENTATION) };
    units = {
      enableHousehold: jest.fn().mockResolvedValue(UNIT_ROW),
      disableHousehold: jest.fn().mockResolvedValue(UNIT_ROW),
      updateHouseholdConfig: jest.fn().mockResolvedValue(UNIT_ROW),
    };
    featureState = { resolveForUnitBySlug: jest.fn().mockResolvedValue(FEATURE_STATE) };
    inventory = { listForHousehold: jest.fn().mockResolvedValue(INVENTORY_PAGE as never) };
    auditContext = { getLocale: jest.fn().mockReturnValue(null) };
    can = jest.fn().mockReturnValue(true);
    abilityService = createMockAbilityService();
    // The instance gate walks the primed abilities the way PoliciesGuard
    // does (every ability must allow), so the mock supplies one.
    abilityService.getCurrentAbilities.mockReturnValue([{ can } as unknown as AppAbility]);
    controller = new HouseholdPluginsController(
      grants as never,
      abilityService as never,
      presentation as never,
      units as never,
      featureState as never,
      inventory as never,
      auditContext as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('decideGrant records a Household-scope decision for the route household, decider from CLS', async () => {
    const result = await firstValueFrom(
      controller.decideGrant('hh-1', 'demo-sink', {
        permissionSlug: 'update:calendar',
        status: PluginGrantStatus.Granted,
      }),
    );

    expect(grants.decide).toHaveBeenCalledWith({
      slug: 'demo-sink',
      scopeType: PluginGrantScope.Household,
      scopeId: 'hh-1',
      permissionSlug: 'update:calendar',
      status: PluginGrantStatus.Granted,
      deciderId: MOCK_ACTING_USER_ID,
    });
    expect(result).toEqual({
      message: expect.objectContaining({
        key: 'success.plugin.grant_decided',
        args: { slug: 'demo-sink', permissionSlug: 'update:calendar' },
      }),
      grant: GRANT,
      changed: true,
    });
  });

  it('consentPresentation renders the route household as the unit, locale from CLS', async () => {
    auditContext.getLocale.mockReturnValue('de');

    const result = await firstValueFrom(controller.consentPresentation('hh-1', 'demo-sink'));

    expect(presentation.presentForUnitBySlug).toHaveBeenCalledWith(
      'demo-sink',
      { scopeType: 'Household', householdId: 'hh-1' },
      'de',
    );
    expect(result).toEqual({ presentation: PRESENTATION });
  });

  it('enable passes the route household, the CLS actor, and the nested config through to the unit writer', async () => {
    const result = await firstValueFrom(
      controller.enable('hh-1', 'demo-sink', { config: { webhookUrl: 'https://x' } }),
    );

    expect(units.enableHousehold).toHaveBeenCalledWith({
      slug: 'demo-sink',
      householdId: 'hh-1',
      actorId: MOCK_ACTING_USER_ID,
      config: { webhookUrl: 'https://x' },
    });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.enabled', args: { slug: 'demo-sink' } }),
      unit: UNIT_ROW,
    });
  });

  it('disable and config PATCH delegate to the unit writer for the route household', async () => {
    await firstValueFrom(controller.disable('hh-1', 'demo-sink'));
    expect(units.disableHousehold).toHaveBeenCalledWith({
      slug: 'demo-sink',
      householdId: 'hh-1',
      actorId: MOCK_ACTING_USER_ID,
    });

    const result = await firstValueFrom(controller.updateConfig('hh-1', 'demo-sink', { config: { a: 1 } }));
    expect(units.updateHouseholdConfig).toHaveBeenCalledWith({
      slug: 'demo-sink',
      householdId: 'hh-1',
      actorId: MOCK_ACTING_USER_ID,
      config: { a: 1 },
    });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.config_updated', args: { slug: 'demo-sink' } }),
      unit: UNIT_ROW,
    });
  });

  it('featureStates renders the route household as the unit, locale from CLS', async () => {
    auditContext.getLocale.mockReturnValue('de');

    const result = await firstValueFrom(controller.featureStates('hh-1', 'demo-sink'));

    expect(featureState.resolveForUnitBySlug).toHaveBeenCalledWith(
      'demo-sink',
      { scopeType: 'Household', householdId: 'hh-1' },
      'de',
    );
    expect(result).toEqual({ featureState: FEATURE_STATE });
  });

  /**
   * The household INSTANCE gate: the `manage:plugin:household` /
   * `read:plugin:household` seeds render one conditioned rule per
   * membership, so the type-level PoliciesGuard check admits an admin of
   * ANY household — this per-route check is what binds the request to ITS
   * `:householdId`. The write path is double-covered (the service seam
   * re-verifies the anchoring household); the read path has only this.
   */
  describe('household instance gate', () => {
    it('checks the action against THIS household before delegating', async () => {
      await firstValueFrom(controller.consentPresentation('hh-1', 'demo-sink'));

      expect(can).toHaveBeenCalledWith(Action.read, expect.objectContaining({ householdId: 'hh-1' }));
    });

    it('refuses a read for a household the actor holds no conditioned rule over — no query runs', async () => {
      can.mockReturnValue(false);

      expect(() => controller.consentPresentation('hh-other', 'demo-sink')).toThrow(ForbiddenException);
      expect(presentation.presentForUnitBySlug).not.toHaveBeenCalled();
    });

    it('refuses a decide the same way — before the service is even asked', async () => {
      can.mockReturnValue(false);

      expect(() =>
        controller.decideGrant('hh-other', 'demo-sink', {
          permissionSlug: 'update:calendar',
          status: PluginGrantStatus.Denied,
        }),
      ).toThrow(ForbiddenException);
      expect(grants.decide).not.toHaveBeenCalled();
    });

    it('binds every #323 write and read to ITS household before the service is asked', async () => {
      can.mockReturnValue(false);

      expect(() => controller.enable('hh-other', 'demo-sink', {})).toThrow(ForbiddenException);
      expect(() => controller.disable('hh-other', 'demo-sink')).toThrow(ForbiddenException);
      expect(() => controller.updateConfig('hh-other', 'demo-sink', { config: {} })).toThrow(ForbiddenException);
      expect(() => controller.featureStates('hh-other', 'demo-sink')).toThrow(ForbiddenException);

      expect(units.enableHousehold).not.toHaveBeenCalled();
      expect(units.disableHousehold).not.toHaveBeenCalled();
      expect(units.updateHouseholdConfig).not.toHaveBeenCalled();
      expect(featureState.resolveForUnitBySlug).not.toHaveBeenCalled();
      // The read gate asks for read, the writes for manage — mirroring the
      // routes' own @CheckPolicies split.
      expect(can).toHaveBeenCalledWith(Action.manage, expect.objectContaining({ householdId: 'hh-other' }));
      expect(can).toHaveBeenCalledWith(Action.read, expect.objectContaining({ householdId: 'hh-other' }));
    });

    it('EVERY primed ability must allow — an API key floor clamps the household gate too', async () => {
      const keyCan = jest.fn().mockReturnValue(false);
      abilityService.getCurrentAbilities.mockReturnValue([
        { can } as unknown as AppAbility,
        { can: keyCan } as unknown as AppAbility,
      ]);

      expect(() => controller.consentPresentation('hh-1', 'demo-sink')).toThrow(ForbiddenException);
    });

    it('denies an EMPTY primed-abilities array — [].every must not vacuously pass the gate', () => {
      // PoliciesGuard throws on this case before today's handlers run, but
      // the mirror must hold on its own for any #323 route added without
      // @CheckPolicies.
      abilityService.getCurrentAbilities.mockReturnValue([]);

      expect(() => controller.consentPresentation('hh-1', 'demo-sink')).toThrow(ForbiddenException);
      expect(presentation.presentForUnitBySlug).not.toHaveBeenCalled();
    });
  });

  describe('installed-plugin inventory (#354)', () => {
    const query = (overrides: Record<string, unknown> = {}) =>
      ({ page: 1, limit: 25, skip: 0, pageSize: 25, ...overrides }) as never;

    it('scopes the read to the route household and wraps it in the #230 envelope', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(controller.list('hh-1', query()));

      expect(inventory.listForHousehold).toHaveBeenCalledWith(
        'hh-1',
        expect.objectContaining({ skip: 0, pageSize: 25 }),
        { includeUninstalled: undefined, locale: 'de' },
      );
      expect(result).toEqual({
        plugins: INVENTORY_PAGE.rows,
        pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false },
      });
    });

    // The read has no service seam to re-verify authority, so the instance
    // gate is the only thing between an admin of household A and household
    // B's enablement states.
    it('refuses a household the caller has no instance-level read on, before touching the service', async () => {
      can.mockReturnValue(false);

      expect(() => controller.list('hh-2', query())).toThrow(ForbiddenException);
      expect(inventory.listForHousehold).not.toHaveBeenCalled();
    });

    it('checks the instance gate against THIS household as a HouseholdPlugin subject', async () => {
      await firstValueFrom(controller.list('hh-1', query()));

      expect(can).toHaveBeenCalledWith(Action.read, expect.objectContaining({ householdId: 'hh-1' }));
    });
  });

  // Read from the decorators, not the instance: these specs construct the
  // controller directly, so a deleted @CheckPolicies would be invisible to
  // every other test here. The instance gate (assertHouseholdScope) is
  // asserted per-route above; this covers the coarse CASL half it layers on.
  describe('policy gates', () => {
    const policiesFor = (handler: string) =>
      Reflect.getMetadata(CHECK_POLICIES_KEY, HouseholdPluginsController.prototype[handler as never]) as
        | Array<(ability: AppAbility) => boolean>
        | undefined;

    it.each([
      ['list', Action.read],
      ['consentPresentation', Action.read],
      ['featureStates', Action.read],
      ['decideGrant', Action.manage],
      ['enable', Action.manage],
      ['disable', Action.manage],
      ['updateConfig', Action.manage],
    ] as const)('%s gates on %s:HouseholdPlugin', (handler, action) => {
      const handlers = policiesFor(handler);
      expect(handlers).toHaveLength(1);

      const gate = jest.fn().mockReturnValue(true);
      handlers?.[0]({ can: gate } as unknown as AppAbility);

      expect(gate).toHaveBeenCalledWith(action, ResourceType.HouseholdPlugin);
    });

    it('every route carries a gate — a new one cannot ship ungated by omission', () => {
      const routes = Object.getOwnPropertyNames(HouseholdPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', HouseholdPluginsController.prototype[name as never]) !== undefined,
      );

      expect(routes.filter((name) => policiesFor(name) === undefined)).toEqual([]);
    });
  });

  describe('route registration', () => {
    // Same `:slug/<literal>` discipline as PluginsController — pinned so a
    // future plain `:slug` or literal sibling must revisit ordering
    // deliberately. #323 extends this class; its routes join this list.
    it.each([
      ['list', '/', RequestMethod.GET],
      ['decideGrant', ':slug/grants', RequestMethod.POST],
      ['consentPresentation', ':slug/consent', RequestMethod.GET],
      ['enable', ':slug/enable', RequestMethod.POST],
      ['disable', ':slug/disable', RequestMethod.POST],
      ['updateConfig', ':slug/config', RequestMethod.PATCH],
      ['featureStates', ':slug/features', RequestMethod.GET],
    ] as const)('binds %s to %s', (handler, path, method) => {
      expect(Reflect.getMetadata('path', HouseholdPluginsController.prototype[handler])).toBe(path);
      expect(Reflect.getMetadata('method', HouseholdPluginsController.prototype[handler])).toBe(method);
    });

    it('registers exactly the grant-consent and unit-enablement routes', () => {
      const handlers = Object.getOwnPropertyNames(HouseholdPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', HouseholdPluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual([
        'list',
        'decideGrant',
        'consentPresentation',
        'enable',
        'disable',
        'updateConfig',
        'featureStates',
      ]);
    });
  });
});
