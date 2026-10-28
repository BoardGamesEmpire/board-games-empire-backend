import type { AuditContextService } from '@bge/actor-context';
import { Action, PluginGrantScope, PluginGrantStatus, ResourceType, type DatabaseService } from '@bge/database';
import { HouseholdLivenessGuard } from '@bge/household';
import {
  CHECK_POLICIES_KEY,
  PoliciesGuard,
  ScopeComposer,
  type AbilityService,
  type AppAbility,
} from '@bge/permissions';
import type {
  PluginConsentPresentation,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginFeatureUnitState,
  PluginGrantService,
  PluginInventoryService,
  PluginUnitLifecycleService,
} from '@bge/plugin';
import { ListScopeNotComposedError } from '@bge/shared';
import { createMockAbilityService, MOCK_ACTING_USER_ID, type MockAbilityService } from '@bge/testing';
import { ForbiddenException, NotFoundException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import 'reflect-metadata';
import { firstValueFrom, type Observable } from 'rxjs';
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
  let householdCount: jest.Mock;
  let scopeComposer: ScopeComposer;

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
    abilityService = createMockAbilityService();
    // The reads' liveness probe; every household here is live unless a test
    // says otherwise.
    householdCount = jest.fn().mockResolvedValue(1);
    // The REAL composer over the mocked ability service, so the list's ceiling
    // is composed and recorded as it is in a request.
    scopeComposer = new ScopeComposer(abilityService as never);
    controller = new HouseholdPluginsController(
      grants as never,
      abilityService as never,
      presentation as never,
      units as never,
      featureState as never,
      inventory as never,
      auditContext as never,
      { household: { count: householdCount } } as unknown as DatabaseService,
      scopeComposer,
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

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.read, ResourceType.HouseholdPlugin, {
        householdId: 'hh-1',
      });
    });

    it('refuses a read for a household the actor holds no conditioned rule over — no query runs', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      expect(() => controller.consentPresentation('hh-other', 'demo-sink')).toThrow(ForbiddenException);
      expect(presentation.presentForUnitBySlug).not.toHaveBeenCalled();
    });

    it('refuses a decide the same way — before the service is even asked', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      expect(() =>
        controller.decideGrant('hh-other', 'demo-sink', {
          permissionSlug: 'update:calendar',
          status: PluginGrantStatus.Denied,
        }),
      ).toThrow(ForbiddenException);
      expect(grants.decide).not.toHaveBeenCalled();
    });

    it('binds every #323 write and read to ITS household before the service is asked', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

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
      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.manage, ResourceType.HouseholdPlugin, {
        householdId: 'hh-other',
      });
      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.read, ResourceType.HouseholdPlugin, {
        householdId: 'hh-other',
      });
    });

    // That every primed ability must allow, and that none primed is a
    // denial, is the shared check's rule, pinned in `ability.service.spec.ts`.
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
        expect.any(Function),
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
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      expect(() => controller.list('hh-2', query())).toThrow(ForbiddenException);
      expect(inventory.listForHousehold).not.toHaveBeenCalled();
      // Liveness comes second, so an actor refused here learns nothing about
      // whether the household exists.
      expect(householdCount).not.toHaveBeenCalled();
    });

    // The route's liveness guard lets through an actor that cannot read
    // households, such as a staff member's key scoped to the plugin routes,
    // and a soft delete leaves the plugin rows in place. The list checks for
    // that actor itself, and answers 403, as the routes do whatever the id.
    it('answers 403 for a household that is gone to an actor who does not read households', async () => {
      householdCount.mockResolvedValue(0);
      abilityService.getCurrentAbilities.mockReturnValue([{ can: () => true }, { can: () => false }] as never);

      await expect(firstValueFrom(controller.list('hh-gone', query()))).rejects.toBeInstanceOf(ForbiddenException);
      expect(householdCount).toHaveBeenCalledWith({ where: { id: 'hh-gone', deletedAt: null } });
      expect(inventory.listForHousehold).not.toHaveBeenCalled();
    });

    it('lists a live household for an actor who does not read households', async () => {
      abilityService.getCurrentAbilities.mockReturnValue([{ can: () => false }] as never);

      await firstValueFrom(controller.list('hh-1', query()));

      expect(householdCount).toHaveBeenCalledTimes(1);
      expect(inventory.listForHousehold).toHaveBeenCalled();
    });

    // The guard has already answered an actor who reads households, 404 for a
    // household that is gone, so a second probe would only repeat its query.
    it('leaves an actor who reads households to the liveness guard', async () => {
      abilityService.getCurrentAbilities.mockReturnValue([{ can: () => true }] as never);

      await firstValueFrom(controller.list('hh-1', query()));

      expect(householdCount).not.toHaveBeenCalled();
      expect(inventory.listForHousehold).toHaveBeenCalled();
    });

    it("hands the runtime the caller's Plugin ceiling to compose the household scope with", async () => {
      const compose = jest.spyOn(scopeComposer, 'compose');
      abilityService.getCurrentResourceConditions.mockReturnValue([{ id: 'p-1' }]);
      const scope = { uninstalledAt: null, OR: [{ householdPlugins: { some: { householdId: 'hh-1' } } }] };

      await firstValueFrom(controller.list('hh-1', query()));
      const ceiling = inventory.listForHousehold.mock.calls[0]?.[2];

      expect(ceiling?.(scope)).toEqual({ ...scope, AND: [{ id: 'p-1' }] });
      expect(compose).toHaveBeenCalledWith(ResourceType.Plugin, Action.read, scope);
    });

    // The runtime calls the ceiling, and composing it is what the envelope's
    // guard checks for. Built inside a request where nothing calls it, the
    // envelope must fail, naming the type.
    it('builds its envelope under the Plugin scope guard', async () => {
      const envelope = ClsServiceManager.getClsService().runWith({}, () =>
        firstValueFrom(controller.list('hh-1', query())),
      );

      await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
      await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.Plugin}'`);
    });

    it('checks the instance gate against THIS household as a HouseholdPlugin subject', async () => {
      await firstValueFrom(controller.list('hh-1', query()));

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.read, ResourceType.HouseholdPlugin, {
        householdId: 'hh-1',
      });
    });
  });

  // The consent and feature-state reads have no write to re-check liveness in
  // either, so a staff member's key scoped to the plugin routes would read a
  // deleted household's decisions through them. They check it as the list
  // does, for the actor the guard let through, and answer the same 403 (#790).
  describe('household liveness on the single reads (#790)', () => {
    const reads = [
      {
        route: 'consentPresentation',
        call: (householdId: string): Observable<unknown> => controller.consentPresentation(householdId, 'demo-sink'),
        service: () => presentation.presentForUnitBySlug,
      },
      {
        route: 'featureStates',
        call: (householdId: string): Observable<unknown> => controller.featureStates(householdId, 'demo-sink'),
        service: () => featureState.resolveForUnitBySlug,
      },
    ];

    it.each(reads)(
      '$route answers 403 for a household that is gone to an actor who does not read households',
      async ({ call, service }) => {
        householdCount.mockResolvedValue(0);
        abilityService.getCurrentAbilities.mockReturnValue([{ can: () => true }, { can: () => false }] as never);

        await expect(firstValueFrom(call('hh-gone'))).rejects.toBeInstanceOf(ForbiddenException);
        expect(householdCount).toHaveBeenCalledWith({ where: { id: 'hh-gone', deletedAt: null } });
        expect(service()).not.toHaveBeenCalled();
      },
    );

    it.each(reads)(
      '$route renders a live household for an actor who does not read households',
      async ({ call, service }) => {
        abilityService.getCurrentAbilities.mockReturnValue([{ can: () => false }] as never);

        await firstValueFrom(call('hh-1'));

        expect(householdCount).toHaveBeenCalledTimes(1);
        expect(service()).toHaveBeenCalled();
      },
    );

    it.each(reads)('$route leaves an actor who reads households to the liveness guard', async ({ call, service }) => {
      abilityService.getCurrentAbilities.mockReturnValue([{ can: () => true }] as never);

      await firstValueFrom(call('hh-1'));

      expect(householdCount).not.toHaveBeenCalled();
      expect(service()).toHaveBeenCalled();
    });

    // Liveness comes second, so an actor the instance check refuses learns
    // nothing about whether the household exists.
    it.each(reads)('$route checks the instance before liveness', ({ call }) => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      expect(() => call('hh-gone')).toThrow(ForbiddenException);
      expect(householdCount).not.toHaveBeenCalled();
    });
  });

  // Read from the decorators, not the instance: these specs construct the
  // controller directly, so a deleted @CheckPolicies would be invisible to
  // every other test here. The instance gate (assertCurrentActorCan) is
  // asserted per-route above; this covers the coarse CASL half it layers on.
  /**
   * #553: these routes sit under `/households/:householdId`, so a missing or
   * soft-deleted household answers 404 here as on the household routes (#299),
   * through the same guard and with its narrowing intact.
   */
  describe('household liveness (#553)', () => {
    it('runs the household liveness guard before PoliciesGuard', () => {
      // Order is the mechanism: after PoliciesGuard, the 403 it answers an
      // actor whose deleted household took its only rule would still win.
      expect(Reflect.getMetadata('__guards__', HouseholdPluginsController)).toEqual([
        HouseholdLivenessGuard,
        PoliciesGuard,
      ]);
    });

    it.each(['list', 'decideGrant', 'consentPresentation', 'enable', 'disable', 'updateConfig', 'featureStates'])(
      'probes the route household on %s, and answers 404 when it is gone',
      async (handler) => {
        const count = jest.fn().mockResolvedValue(0);
        const guard = new HouseholdLivenessGuard(
          new Reflector(),
          { household: { count } } as unknown as DatabaseService,
          { getCurrentAbilities: () => [{ can: () => true }] } as unknown as AbilityService,
        );
        const context = {
          getClass: () => HouseholdPluginsController,
          getHandler: () => HouseholdPluginsController.prototype[handler as keyof HouseholdPluginsController],
          switchToHttp: () => ({ getRequest: () => ({ params: { householdId: 'hh-gone', slug: 'demo-sink' } }) }),
        } as unknown as ExecutionContext;

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException);
        expect(count).toHaveBeenCalledWith({ where: { id: 'hh-gone', deletedAt: null } });
      },
    );
  });

  describe('policy gates', () => {
    const policiesFor = (handler: string) =>
      Reflect.getMetadata(CHECK_POLICIES_KEY, HouseholdPluginsController.prototype[handler as never]) as
        | Array<(ability: AppAbility) => boolean>
        | undefined;

    // The rows are plugins, so the list composes a `Plugin` ceiling and an
    // actor with no rule on `Plugin` is refused here, not served an empty page.
    it('list gates on read:HouseholdPlugin and read:Plugin', () => {
      const handlers = policiesFor('list');
      expect(handlers).toHaveLength(2);

      const can = jest.fn().mockReturnValue(true);
      for (const handler of handlers ?? []) {
        handler({ can } as unknown as AppAbility);
      }

      expect(can.mock.calls).toEqual([
        [Action.read, ResourceType.HouseholdPlugin],
        [Action.read, ResourceType.Plugin],
      ]);
    });

    it.each([
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
