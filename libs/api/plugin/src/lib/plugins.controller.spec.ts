import type { AuditContextService } from '@bge/actor-context';
import { SERVER_PLUGIN_UNIT } from '@bge/actor-context';
import { Action, PluginGrantScope, PluginGrantStatus, ResourceType } from '@bge/database';
import { CHECK_POLICIES_KEY, type AppAbility } from '@bge/permissions';
import type {
  PluginConsentPresentation,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginFeatureUnitState,
  PluginGrantService,
  PluginInventoryService,
  PluginLifecycleService,
  PluginUpdateService,
  UpdateEscalationComparison,
} from '@bge/plugin';
import { PluginUpdateNoPendingError } from '@bge/plugin';
import { createMockAbilityService, MOCK_ACTING_USER_ID, type MockAbilityService } from '@bge/testing';
import { RequestMethod } from '@nestjs/common';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { PluginsController } from './plugins.controller';

const PLUGIN = { id: 'plugin-1', slug: 'demo-sink', enabled: true } as never;
const AFFECTED_UNITS = [{ scopeType: 'Household', householdId: 'hh-1' }] as never[];

const APPROVED_PLUGIN = { id: 'plugin-1', slug: 'demo-sink', version: '1.3.0', restartRequired: true } as never;
const COMPARISON = {
  escalations: [],
  serverGating: true,
  blockedByDenial: [],
} as unknown as UpdateEscalationComparison;
const SEEDED_GRANTS = [{ id: 'grant-1', permissionSlug: 'user:impersonate' }] as never[];
const SUSPENDED_HOUSEHOLDS = [{ householdId: 'hh-1', outstanding: ['calendar:read'] }];
const PENDING_PLUGIN = {
  id: 'plugin-1',
  slug: 'demo-sink',
  enabled: true,
  version: '1.2.0',
  pendingVersion: '1.3.0',
} as never;
const DECLARES = { added: ['plugin|demo-sink|manage:digest'], removed: ['plugin|demo-sink|read:legacy'] };
const PRESENTATION = {
  plugin: { id: 'plugin-1', slug: 'demo-sink', enabled: true },
  manifestVersion: '1.3.0',
  source: 'pending',
  checks: [],
} as unknown as PluginConsentPresentation;
const ACTIVE_PRESENTATION = {
  plugin: { id: 'plugin-1', slug: 'demo-sink', enabled: true },
  manifestVersion: '1.2.0',
  source: 'active',
  checks: [],
} as unknown as PluginConsentPresentation;
const GRANT = { id: 'grant-1', permissionSlug: 'feedback:read', status: PluginGrantStatus.Granted } as never;
const INVENTORY_PAGE = {
  rows: [{ id: 'plugin-1', slug: 'demo-sink', displayName: 'Demo Sink', manifestUnreadable: false }],
  total: 1,
};
const DETAIL = { id: 'plugin-1', slug: 'demo-sink', executionMode: 'InProcess', features: [] } as never;
const FEATURE_STATE = {
  plugin: { id: 'plugin-1', slug: 'demo-sink' },
  unit: SERVER_PLUGIN_UNIT,
  served: true,
  suspendedForConsent: false,
  features: [
    {
      name: 'digest',
      displayName: 'Digest',
      description: 'Weekly digest',
      state: 'active',
      reason: null,
      blockingSlugs: [],
      perUnitSlugs: ['plugin|demo-sink|read:household'],
    },
  ],
} as unknown as PluginFeatureUnitState;

describe('PluginsController (delegation)', () => {
  let controller: PluginsController;
  let lifecycle: jest.Mocked<Pick<PluginLifecycleService, 'enable' | 'disable' | 'updateConfig' | 'uninstall'>>;
  let updates: jest.Mocked<Pick<PluginUpdateService, 'approve' | 'reject' | 'describePending'>>;
  let presentation: jest.Mocked<
    Pick<PluginConsentPresentationService, 'presentPendingFromRow' | 'presentForUnitBySlug'>
  >;
  let grants: jest.Mocked<Pick<PluginGrantService, 'decide'>>;
  let featureState: jest.Mocked<Pick<PluginFeatureStateService, 'resolveForUnitBySlug'>>;
  let inventory: jest.Mocked<Pick<PluginInventoryService, 'listForServer' | 'getBySlug'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale'>>;
  let abilityService: MockAbilityService;

  beforeEach(() => {
    lifecycle = {
      enable: jest.fn().mockResolvedValue(PLUGIN),
      disable: jest.fn().mockResolvedValue(PLUGIN),
      updateConfig: jest.fn().mockResolvedValue(PLUGIN),
      uninstall: jest.fn().mockResolvedValue({ plugin: PLUGIN, affectedUnits: AFFECTED_UNITS }),
    };
    updates = {
      approve: jest.fn().mockResolvedValue({
        plugin: APPROVED_PLUGIN,
        comparison: COMPARISON,
        seededGrants: SEEDED_GRANTS,
        suspendedHouseholdUnits: SUSPENDED_HOUSEHOLDS,
        suspendedUserUnits: [],
      }),
      reject: jest.fn().mockResolvedValue(PLUGIN),
      describePending: jest.fn().mockResolvedValue({
        plugin: PENDING_PLUGIN,
        comparison: COMPARISON,
        pendingSince: new Date('2026-07-29T00:00:00Z'),
        declares: DECLARES,
      }),
    };
    presentation = {
      presentPendingFromRow: jest.fn().mockResolvedValue(PRESENTATION),
      presentForUnitBySlug: jest.fn().mockResolvedValue(ACTIVE_PRESENTATION),
    };
    grants = { decide: jest.fn().mockResolvedValue({ grant: GRANT, changed: true }) };
    featureState = { resolveForUnitBySlug: jest.fn().mockResolvedValue(FEATURE_STATE) };
    inventory = {
      listForServer: jest.fn().mockResolvedValue(INVENTORY_PAGE as never),
      getBySlug: jest.fn().mockResolvedValue(DETAIL),
    };
    auditContext = { getLocale: jest.fn().mockReturnValue(null) };
    abilityService = createMockAbilityService();
    controller = new PluginsController(
      lifecycle as never,
      abilityService as never,
      updates as never,
      grants as never,
      presentation as never,
      featureState as never,
      inventory as never,
      auditContext as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('enable resolves the actor from CLS and forwards slug + actorId, wrapping with a success message', async () => {
    const result = await firstValueFrom(controller.enable('demo-sink'));

    expect(lifecycle.enable).toHaveBeenCalledWith({ slug: 'demo-sink', actorId: MOCK_ACTING_USER_ID });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.enabled', args: { slug: 'demo-sink' } }),
      plugin: PLUGIN,
    });
  });

  it('disable forwards slug + actorId, wrapping with a success message', async () => {
    const result = await firstValueFrom(controller.disable('demo-sink'));

    expect(lifecycle.disable).toHaveBeenCalledWith({ slug: 'demo-sink', actorId: MOCK_ACTING_USER_ID });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.disabled', args: { slug: 'demo-sink' } }),
      plugin: PLUGIN,
    });
  });

  it('updateConfig unwraps the DTO envelope — the service receives the config object itself', async () => {
    const config = { webhookUrl: 'https://example.test/hook' };

    const result = await firstValueFrom(controller.updateConfig('demo-sink', { config }));

    expect(lifecycle.updateConfig).toHaveBeenCalledWith({ slug: 'demo-sink', actorId: MOCK_ACTING_USER_ID, config });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.config_updated', args: { slug: 'demo-sink' } }),
      plugin: PLUGIN,
    });
  });

  it('uninstall forwards purgeData and surfaces the affected units beside the tombstoned row', async () => {
    const result = await firstValueFrom(controller.uninstall('demo-sink', { purgeData: true }));

    expect(lifecycle.uninstall).toHaveBeenCalledWith({
      slug: 'demo-sink',
      actorId: MOCK_ACTING_USER_ID,
      purgeData: true,
    });
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.uninstalled', args: { slug: 'demo-sink' } }),
      plugin: PLUGIN,
      affectedUnits: AFFECTED_UNITS,
    });
  });

  it('an omitted purgeData stays undefined — the service owns the default', async () => {
    await firstValueFrom(controller.uninstall('demo-sink', {}));

    expect(lifecycle.uninstall).toHaveBeenCalledWith({
      slug: 'demo-sink',
      actorId: MOCK_ACTING_USER_ID,
      purgeData: undefined,
    });
  });

  describe('update consent endpoints (#321)', () => {
    it('approveUpdate forwards slug, actor, and the confirmation set; the response surfaces the consequences', async () => {
      const result = await firstValueFrom(
        controller.approveUpdate('demo-sink', { confirmCriticalSlugs: ['user:impersonate'] }),
      );

      expect(updates.approve).toHaveBeenCalledWith({
        slug: 'demo-sink',
        approverId: MOCK_ACTING_USER_ID,
        confirmCriticalSlugs: ['user:impersonate'],
      });
      expect(result).toEqual({
        message: expect.objectContaining({
          key: 'success.plugin.update_approved',
          args: { slug: 'demo-sink', version: '1.3.0' },
        }),
        plugin: APPROVED_PLUGIN,
        comparison: COMPARISON,
        seededGrants: SEEDED_GRANTS,
        restartRequired: true,
        suspendedHouseholdUnits: SUSPENDED_HOUSEHOLDS,
        suspendedUserUnits: [],
      });
    });

    it('an omitted confirmation set stays undefined — the service owns the expectation', async () => {
      await firstValueFrom(controller.approveUpdate('demo-sink', {}));

      expect(updates.approve).toHaveBeenCalledWith({
        slug: 'demo-sink',
        approverId: MOCK_ACTING_USER_ID,
        confirmCriticalSlugs: undefined,
      });
    });

    it('rejectUpdate forwards slug + actorId, wrapping with a success message', async () => {
      const result = await firstValueFrom(controller.rejectUpdate('demo-sink'));

      expect(updates.reject).toHaveBeenCalledWith({ slug: 'demo-sink', rejectorId: MOCK_ACTING_USER_ID });
      expect(result).toEqual({
        message: expect.objectContaining({ key: 'success.plugin.update_rejected', args: { slug: 'demo-sink' } }),
        plugin: PLUGIN,
      });
    });

    it('pendingUpdate presents from the SAME row the description loaded — one snapshot, locale from CLS', async () => {
      auditContext.getLocale.mockReturnValue('en');

      const result = await firstValueFrom(controller.pendingUpdate('demo-sink'));

      expect(updates.describePending).toHaveBeenCalledWith('demo-sink');
      // The row object itself, not a re-read by id: a re-read could observe
      // a replacement staging — possibly under the same version — and the
      // body would mix two updates.
      expect(presentation.presentPendingFromRow).toHaveBeenCalledWith(PENDING_PLUGIN, SERVER_PLUGIN_UNIT, 'en');
      expect(result).toEqual({
        activeVersion: '1.2.0',
        pendingVersion: '1.3.0',
        pendingSince: new Date('2026-07-29T00:00:00Z'),
        escalations: COMPARISON.escalations,
        serverGating: true,
        blockedByDenial: [],
        // The catalog diff rides the body: no escalation kind describes a
        // declaration change, so a client cannot reconstruct it.
        declares: DECLARES,
        presentation: PRESENTATION,
      });
    });

    it('an unresolved CLS locale is passed as undefined — the presentation falls back to the default locale', async () => {
      auditContext.getLocale.mockReturnValue(null);

      await firstValueFrom(controller.pendingUpdate('demo-sink'));

      expect(presentation.presentPendingFromRow).toHaveBeenCalledWith(PENDING_PLUGIN, SERVER_PLUGIN_UNIT, undefined);
    });

    it('maps a null presentation to the typed no-pending refusal, never a null body', async () => {
      presentation.presentPendingFromRow.mockResolvedValue(null);

      await expect(firstValueFrom(controller.pendingUpdate('demo-sink'))).rejects.toThrow(PluginUpdateNoPendingError);
    });
  });

  describe('grant decide + consent presentation (#322)', () => {
    it('decideGrant records a Server-scope decision with the CLS actor as decider — never the body', async () => {
      const result = await firstValueFrom(
        controller.decideGrant('demo-sink', {
          permissionSlug: 'feedback:read',
          status: PluginGrantStatus.Granted,
        }),
      );

      expect(grants.decide).toHaveBeenCalledWith({
        slug: 'demo-sink',
        scopeType: PluginGrantScope.Server,
        permissionSlug: 'feedback:read',
        status: PluginGrantStatus.Granted,
        deciderId: MOCK_ACTING_USER_ID,
      });
      expect(result).toEqual({
        message: expect.objectContaining({
          key: 'success.plugin.grant_decided',
          args: { slug: 'demo-sink', permissionSlug: 'feedback:read' },
        }),
        grant: GRANT,
        changed: true,
      });
    });

    it('consentPresentation renders the Server unit from the slug entry point, locale from CLS', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(controller.consentPresentation('demo-sink'));

      expect(presentation.presentForUnitBySlug).toHaveBeenCalledWith('demo-sink', SERVER_PLUGIN_UNIT, 'de');
      expect(result).toEqual({ presentation: ACTIVE_PRESENTATION });
    });

    it('an unresolved CLS locale is passed as undefined — the presentation falls back to the default locale', async () => {
      auditContext.getLocale.mockReturnValue(null);

      await firstValueFrom(controller.consentPresentation('demo-sink'));

      expect(presentation.presentForUnitBySlug).toHaveBeenCalledWith('demo-sink', SERVER_PLUGIN_UNIT, undefined);
    });
  });

  describe('server-axis feature state (#354, D-BX)', () => {
    it('renders the Server unit through the slug entry point, locale from CLS', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(controller.featureStates('demo-sink'));

      expect(featureState.resolveForUnitBySlug).toHaveBeenCalledWith('demo-sink', SERVER_PLUGIN_UNIT, 'de');
      expect(result).toEqual({ featureState: FEATURE_STATE });
    });

    it('an unresolved CLS locale is passed as undefined — the derivation falls back to the default locale', async () => {
      auditContext.getLocale.mockReturnValue(null);

      await firstValueFrom(controller.featureStates('demo-sink'));

      expect(featureState.resolveForUnitBySlug).toHaveBeenCalledWith('demo-sink', SERVER_PLUGIN_UNIT, undefined);
    });

    it('surfaces perUnitSlugs — the field the server viewpoint exists to report', async () => {
      const result = await firstValueFrom(controller.featureStates('demo-sink'));

      expect(result.featureState.features[0].perUnitSlugs).toEqual(['plugin|demo-sink|read:household']);
    });
  });

  describe('installed-plugin inventory (#354)', () => {
    const query = (overrides: Record<string, unknown> = {}) =>
      ({ page: 1, limit: 25, skip: 0, pageSize: 25, ...overrides }) as never;

    it('wraps the rows in the #230 envelope, echoing the paging the read used (D-CD)', async () => {
      const result = await firstValueFrom(controller.list(query({ page: 2, skip: 25 })));

      expect(result).toEqual({
        plugins: INVENTORY_PAGE.rows,
        pagination: { page: 2, limit: 25, total: 1, totalPages: 1, hasMore: false },
      });
    });

    it('passes the query straight through as the paging, so skip and the echoed limit cannot disagree', async () => {
      await firstValueFrom(controller.list(query({ page: 3, skip: 50 })));

      expect(inventory.listForServer).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, pageSize: 25 }),
        expect.anything(),
      );
    });

    it('forwards the tombstone opt-in and the CLS locale (D-CH)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      await firstValueFrom(controller.list(query({ includeUninstalled: true })));

      expect(inventory.listForServer).toHaveBeenCalledWith(expect.anything(), {
        includeUninstalled: true,
        locale: 'de',
      });
    });

    it('an omitted opt-in stays undefined — the service owns the default', async () => {
      await firstValueFrom(controller.list(query()));

      expect(inventory.listForServer).toHaveBeenCalledWith(expect.anything(), {
        includeUninstalled: undefined,
        locale: undefined,
      });
    });

    it('getBySlug takes no tombstone flag — 410 is unconditional there (D-CH)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(controller.getBySlug('demo-sink'));

      expect(inventory.getBySlug).toHaveBeenCalledWith('demo-sink', 'de');
      expect(result).toEqual({ plugin: DETAIL });
    });
  });

  // The controller specs instantiate the class directly, so a dropped
  // @CheckPolicies would change nothing they assert. These read the decorator
  // metadata instead: without them, deleting the `read:plugin` gate from a
  // route that serves installedSha256/installedFromUrl/installedAt would pass
  // the whole suite.
  describe('policy gates', () => {
    const policiesFor = (handler: keyof PluginsController) =>
      Reflect.getMetadata(CHECK_POLICIES_KEY, PluginsController.prototype[handler]) as
        | Array<(ability: AppAbility) => boolean>
        | undefined;

    it.each([
      ['list', Action.read],
      ['getBySlug', Action.read],
      ['featureStates', Action.read],
      ['consentPresentation', Action.read],
      ['pendingUpdate', Action.read],
      ['decideGrant', Action.manage],
      ['enable', Action.manage],
      ['disable', Action.manage],
      ['updateConfig', Action.manage],
      ['uninstall', Action.manage],
      ['approveUpdate', Action.manage],
      ['rejectUpdate', Action.manage],
    ] as const)('%s gates on %s:Plugin', (handler, action) => {
      const handlers = policiesFor(handler);
      expect(handlers).toHaveLength(1);

      const can = jest.fn().mockReturnValue(true);
      handlers?.[0]({ can } as unknown as AppAbility);

      expect(can).toHaveBeenCalledWith(action, ResourceType.Plugin);
    });

    it('attaches PoliciesGuard at the class level, so every route above is actually evaluated', () => {
      const guards = Reflect.getMetadata('__guards__', PluginsController) as unknown[] | undefined;

      expect(guards?.length).toBeGreaterThan(0);
    });

    it('every route carries a gate — a new one cannot ship ungated by omission', () => {
      const routes = Object.getOwnPropertyNames(PluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', PluginsController.prototype[name as never]) !== undefined,
      );

      expect(routes.filter((name) => policiesFor(name as keyof PluginsController) === undefined)).toEqual([]);
    });
  });

  describe('route registration', () => {
    // `:slug` now exists as a one-segment parametric GET, so ordering DOES
    // carry a constraint: it is declared last, after every `:slug/<literal>`
    // route, and a future single-segment LITERAL route (`@Get('summary')`)
    // must go BEFORE it or be swallowed. The handler-order assertion below
    // is what forces that decision to be made rather than discovered.
    it.each([
      ['list', '/', RequestMethod.GET],
      ['decideGrant', ':slug/grants', RequestMethod.POST],
      ['consentPresentation', ':slug/consent', RequestMethod.GET],
      ['enable', ':slug/enable', RequestMethod.POST],
      ['disable', ':slug/disable', RequestMethod.POST],
      ['updateConfig', ':slug/config', RequestMethod.PATCH],
      ['uninstall', ':slug/uninstall', RequestMethod.POST],
      ['approveUpdate', ':slug/update/approve', RequestMethod.POST],
      ['rejectUpdate', ':slug/update/reject', RequestMethod.POST],
      ['pendingUpdate', ':slug/update/pending', RequestMethod.GET],
      ['featureStates', ':slug/features', RequestMethod.GET],
      ['getBySlug', ':slug', RequestMethod.GET],
    ] as const)('binds %s to %s', (handler, path, method) => {
      expect(Reflect.getMetadata('path', PluginsController.prototype[handler])).toBe(path);
      expect(Reflect.getMetadata('method', PluginsController.prototype[handler])).toBe(method);
    });

    it('registers exactly the lifecycle, update-consent, and grant-consent routes', () => {
      const handlers = Object.getOwnPropertyNames(PluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', PluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual([
        'list',
        'decideGrant',
        'consentPresentation',
        'enable',
        'disable',
        'updateConfig',
        'uninstall',
        'approveUpdate',
        'rejectUpdate',
        'pendingUpdate',
        'featureStates',
        // Last, and it must stay last: a one-segment `:slug` declared ahead
        // of a one-segment literal route would shadow it.
        'getBySlug',
      ]);
    });
  });
});
