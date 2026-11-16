import type { Actor, AuditContextService } from '@bge/actor-context';
import { Action, PluginGrantStatus, ResourceType, RiskLevel } from '@bge/database';
import { CHECK_POLICIES_KEY, PoliciesGuard, ScopeComposer, type AppAbility } from '@bge/permissions';
import type {
  PluginConsentActService,
  PluginConsentPresentation,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginFeatureUnitState,
  PluginInventoryService,
  PluginUnitLifecycleService,
} from '@bge/plugin';
import { ListScopeNotComposedError } from '@bge/shared';
import { createMockAbilityService, type MockAbilityService } from '@bge/testing';
import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { UserPluginsController } from './user-plugins.controller';

const USER_ID = 'user-e2e-1';

const PRESENTATION = {
  plugin: { id: 'plugin-1', slug: 'demo-sink', enabled: true },
  manifestVersion: '1.2.0',
  source: 'active',
  checks: [],
} as unknown as PluginConsentPresentation;
const STAGED_PRESENTATION = {
  plugin: { id: 'plugin-1', slug: 'demo-sink', enabled: true },
  manifestVersion: '1.3.0',
  source: 'staged',
  checks: [],
} as unknown as PluginConsentPresentation;
const UNIT_ROW = { id: 'up-1', userId: USER_ID, pluginId: 'plugin-1', enabled: true } as never;
const SHA = 'b'.repeat(64);
const ANSWER = { permissionSlug: 'read:public_content', status: PluginGrantStatus.Granted, riskLevel: RiskLevel.Low };
const DECIDED_AT = new Date('2026-11-14T00:00:00Z');
const ACT = { id: 'act-1', kind: 'Toggle', decidedAt: DECIDED_AT, presentation: {} } as never;
const INVENTORY_PAGE = {
  rows: [
    {
      id: 'plugin-1',
      slug: 'demo-sink',
      serverEnabled: true,
      unit: {
        anchored: false,
        enabled: false,
        state: 'off',
        dormancy: null,
        consent: { outstanding: [], optionalOff: [] },
      },
    },
  ],
  total: 1,
};
const FEATURE_STATE = {
  plugin: { id: 'plugin-1', slug: 'demo-sink' },
  unit: { scopeType: 'User', userId: USER_ID },
  served: true,
  serverEnabled: true,
  state: 'on',
  dormancy: null,
  consent: { outstanding: [], optionalOff: [] },
  features: [],
} as unknown as PluginFeatureUnitState;

describe('UserPluginsController (delegation + actor-kind floor)', () => {
  let controller: UserPluginsController;
  let consentActs: jest.Mocked<Pick<PluginConsentActService, 'switchOn' | 'toggle' | 'review'>>;
  let presentation: jest.Mocked<
    Pick<PluginConsentPresentationService, 'presentForUnitBySlug' | 'presentStagedForUnitBySlug'>
  >;
  let units: jest.Mocked<Pick<PluginUnitLifecycleService, 'disableUser'>>;
  let featureState: jest.Mocked<Pick<PluginFeatureStateService, 'resolveForUnitBySlug'>>;
  let inventory: jest.Mocked<Pick<PluginInventoryService, 'listForUser'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale' | 'getActor'>>;
  let abilityService: MockAbilityService;
  let scopeComposer: ScopeComposer;

  beforeEach(() => {
    const result = { act: ACT, changed: true, unit: UNIT_ROW, switchedOff: false };
    consentActs = {
      switchOn: jest.fn().mockResolvedValue(result),
      toggle: jest.fn().mockResolvedValue(result),
      review: jest.fn().mockResolvedValue(result),
    };
    presentation = {
      presentForUnitBySlug: jest.fn().mockResolvedValue(PRESENTATION),
      presentStagedForUnitBySlug: jest.fn().mockResolvedValue(STAGED_PRESENTATION),
    };
    units = {
      disableUser: jest.fn().mockResolvedValue(UNIT_ROW),
    };
    featureState = { resolveForUnitBySlug: jest.fn().mockResolvedValue(FEATURE_STATE) };
    inventory = { listForUser: jest.fn().mockResolvedValue(INVENTORY_PAGE as never) };
    auditContext = {
      getLocale: jest.fn().mockReturnValue(null),
      getActor: jest.fn().mockReturnValue({ kind: 'user', userId: USER_ID } as Actor),
    };
    abilityService = createMockAbilityService();
    // The REAL composer over the mocked ability service, so the list's ceiling
    // is composed and recorded as it is in a request.
    scopeComposer = new ScopeComposer(abilityService as never);
    controller = new UserPluginsController(
      consentActs as never,
      presentation as never,
      units as never,
      featureState as never,
      inventory as never,
      auditContext as never,
      scopeComposer,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('consentPresentation renders the session user as the unit, locale from CLS', async () => {
    auditContext.getLocale.mockReturnValue('de-AT');

    const result = await firstValueFrom(controller.consentPresentation('demo-sink'));

    expect(presentation.presentForUnitBySlug).toHaveBeenCalledWith(
      'demo-sink',
      { scopeType: 'User', userId: USER_ID },
      'de-AT',
    );
    expect(result).toEqual({ presentation: PRESENTATION });
  });

  it('serves the staged consent surface when asked (#1150)', async () => {
    auditContext.getLocale.mockReturnValue('de');

    const result = await firstValueFrom(controller.consentPresentation('demo-sink', { manifest: 'staged' }));

    // The user pre-consents from the staged update's consent surface.
    expect(presentation.presentStagedForUnitBySlug).toHaveBeenCalledWith(
      'demo-sink',
      { scopeType: 'User', userId: USER_ID },
      'de',
    );
    expect(presentation.presentForUnitBySlug).not.toHaveBeenCalled();
    expect(result).toEqual({ presentation: STAGED_PRESENTATION });
  });

  it('an unresolved CLS locale is passed as undefined — the presentation falls back to the default locale', async () => {
    auditContext.getLocale.mockReturnValue(null);

    await firstValueFrom(controller.consentPresentation('demo-sink'));

    expect(presentation.presentForUnitBySlug).toHaveBeenCalledWith(
      'demo-sink',
      { scopeType: 'User', userId: USER_ID },
      undefined,
    );
  });

  // The three consent act routes (#1150): the session user is both the unit
  // and the actor, so no other user's unit is addressable.
  describe('consent acts (#1150)', () => {
    const unit = { scopeType: 'User', userId: USER_ID };
    const actBody = { id: 'act-1', kind: 'Toggle', decidedAt: DECIDED_AT };

    it('enable switches the plugin on with the unit, the actor, the sha, the answers and the locale (#1150)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(controller.enable('demo-sink', { manifestSha256: SHA, answers: [ANSWER] }));

      expect(consentActs.switchOn).toHaveBeenCalledWith({
        slug: 'demo-sink',
        unit,
        actorId: USER_ID,
        manifestSha256: SHA,
        answers: [ANSWER],
        locale: 'de',
      });
      expect(result).toEqual({
        message: expect.objectContaining({ key: 'success.plugin.enabled', args: { slug: 'demo-sink' } }),
        changed: true,
        switchedOff: false,
        act: actBody,
        unit: UNIT_ROW,
      });
    });

    it('toggle records one answer with the unit, the actor, the sha and the locale (#1150)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(
        controller.toggleConsent('demo-sink', { manifestSha256: SHA, answer: ANSWER }),
      );

      expect(consentActs.toggle).toHaveBeenCalledWith({
        slug: 'demo-sink',
        unit,
        actorId: USER_ID,
        manifestSha256: SHA,
        answers: [ANSWER],
        locale: 'de',
      });
      expect(result).toEqual(
        expect.objectContaining({
          message: expect.objectContaining({ key: 'success.plugin.consent_recorded', args: { slug: 'demo-sink' } }),
        }),
      );
    });

    it('review records the answers with the unit, the actor, the sha and the locale (#1150)', async () => {
      await firstValueFrom(controller.reviewConsent('demo-sink', { manifestSha256: SHA, answers: [ANSWER] }));

      expect(consentActs.review).toHaveBeenCalledWith({
        slug: 'demo-sink',
        unit,
        actorId: USER_ID,
        manifestSha256: SHA,
        answers: [ANSWER],
        locale: undefined,
      });
    });

    it('a review that switched the unit off answers with the switched-off message (#1150)', async () => {
      consentActs.review.mockResolvedValue({ act: ACT, changed: true, unit: UNIT_ROW, switchedOff: true });

      const result = await firstValueFrom(
        controller.reviewConsent('demo-sink', { manifestSha256: SHA, answers: [ANSWER] }),
      );

      expect(result).toEqual(
        expect.objectContaining({
          message: expect.objectContaining({ key: 'success.plugin.consent_refused_switched_off' }),
          switchedOff: true,
        }),
      );
    });
  });

  it('disable addresses the session user only, and renders the unit with the shared success key', async () => {
    const disabled = await firstValueFrom(controller.disable('demo-sink'));

    expect(units.disableUser).toHaveBeenCalledWith({ slug: 'demo-sink', userId: USER_ID });
    expect(disabled).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.disabled', args: { slug: 'demo-sink' } }),
      unit: UNIT_ROW,
    });
  });

  it('featureStates renders the session user as the unit, locale from CLS', async () => {
    auditContext.getLocale.mockReturnValue('de');

    const result = await firstValueFrom(controller.featureStates('demo-sink'));

    expect(featureState.resolveForUnitBySlug).toHaveBeenCalledWith(
      'demo-sink',
      { scopeType: 'User', userId: USER_ID },
      'de',
    );
    expect(result).toEqual({ featureState: FEATURE_STATE });
  });

  /**
   * The actor-kind floor: no permission seed exists for deciding on this axis
   * (#59's C4 seeded server + household pairs only), so there is no ability for
   * PoliciesGuard to AND an API key against — the kind check is the floor.
   * An API key resolves to its OWNER's id everywhere else; here that would
   * let a key of ANY scope consent to third-party code on the owner's
   * behalf and mint their enablement anchor.
   */
  describe('actor-kind floor', () => {
    it.each([
      ['apiKey', { kind: 'apiKey', userId: USER_ID, apiKeyId: 'key-1' }],
      ['system', { kind: 'system', reason: 'migration' }],
      ['plugin', { kind: 'plugin', pluginId: 'plugin-1', slug: 'demo-sink', unit: { scopeType: 'Server' } }],
    ] as const)('refuses a %s actor on a consent act — before the service is even asked (#1150)', (_kind, actor) => {
      auditContext.getActor.mockReturnValue(actor as unknown as Actor);

      expect(() => controller.toggleConsent('demo-sink', { manifestSha256: SHA, answer: ANSWER })).toThrow(
        ForbiddenException,
      );
      expect(consentActs.toggle).not.toHaveBeenCalled();
    });

    it('refuses a non-user actor on the consent read the same way', () => {
      auditContext.getActor.mockReturnValue({ kind: 'apiKey', userId: USER_ID, apiKeyId: 'key-1' } as unknown as Actor);

      expect(() => controller.consentPresentation('demo-sink')).toThrow(ForbiddenException);
      expect(presentation.presentForUnitBySlug).not.toHaveBeenCalled();
    });

    it('refuses when no actor is in context at all', () => {
      auditContext.getActor.mockReturnValue(null);

      expect(() => controller.consentPresentation('demo-sink')).toThrow(ForbiddenException);
    });

    it.each([
      ['enable', () => controller.enable('demo-sink', { manifestSha256: SHA, answers: [] })],
      ['reviewConsent', () => controller.reviewConsent('demo-sink', { manifestSha256: SHA, answers: [ANSWER] })],
      ['disable', () => controller.disable('demo-sink')],
      ['featureStates', () => controller.featureStates('demo-sink')],
    ] as const)('the floor holds on the %s route too — before the service is asked', (_name, invoke) => {
      auditContext.getActor.mockReturnValue({ kind: 'apiKey', userId: USER_ID, apiKeyId: 'key-1' } as unknown as Actor);

      expect(invoke).toThrow(ForbiddenException);
      expect(consentActs.switchOn).not.toHaveBeenCalled();
      expect(consentActs.review).not.toHaveBeenCalled();
      expect(units.disableUser).not.toHaveBeenCalled();
      expect(featureState.resolveForUnitBySlug).not.toHaveBeenCalled();
    });
  });

  describe('installed-plugin inventory (#354)', () => {
    const query = (overrides: Record<string, unknown> = {}) =>
      ({ page: 1, limit: 25, skip: 0, pageSize: 25, ...overrides }) as never;

    it('resolves the user from CLS and wraps the rows in the #230 envelope', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(controller.list(query()));

      expect(inventory.listForUser).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ skip: 0, pageSize: 25 }),
        expect.any(Function),
        { includeUninstalled: undefined, locale: 'de' },
      );
      expect(result).toEqual({
        plugins: INVENTORY_PAGE.rows,
        pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false },
      });
    });

    it("hands the runtime the caller's Plugin ceiling to compose the user scope with", async () => {
      const compose = jest.spyOn(scopeComposer, 'compose');
      abilityService.getCurrentResourceConditions.mockReturnValue([{ id: 'p-1' }]);

      await firstValueFrom(controller.list(query()));
      const ceiling = inventory.listForUser.mock.calls[0]?.[2];

      expect(ceiling?.({ uninstalledAt: null })).toEqual({ uninstalledAt: null, AND: [{ id: 'p-1' }] });
      expect(compose).toHaveBeenCalledWith(ResourceType.Plugin, Action.read, { uninstalledAt: null });
    });

    // The runtime calls the ceiling, and composing it is what the envelope's
    // guard checks for. Built inside a request where nothing calls it, the
    // envelope must fail, naming the type.
    it('builds its envelope under the Plugin scope guard', async () => {
      const envelope = ClsServiceManager.getClsService().runWith({}, () => firstValueFrom(controller.list(query())));

      await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
      await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.Plugin}'`);
    });

    // The actor-KIND floor holds on the list too. Its policy gate checks the
    // key's ceiling, but the list exists to decide consent, which a key acting
    // as its owner cannot give.
    it('refuses a non-user actor before touching the service', () => {
      auditContext.getActor.mockReturnValue({ kind: 'apiKey', apiKeyId: 'key-1' } as unknown as Actor);

      expect(() => controller.list(query())).toThrow(ForbiddenException);
      expect(inventory.listForUser).not.toHaveBeenCalled();
    });
  });

  // Deciding on this axis has no permission seed (#59's C4 seeded only the server
  // and household pairs), so the gate is the actor KIND. The list alone reads
  // through a seed, `read:plugin:installed`, and composes a `Plugin` ceiling,
  // so it alone carries a policy gate: an actor with no rule on `Plugin` is
  // refused rather than served an empty page. Pinned both ways: no other route
  // may quietly acquire a CASL gate that would have nothing to clamp, and none
  // may skip the kind check.
  describe('gate shape', () => {
    const routes = () =>
      Object.getOwnPropertyNames(UserPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', UserPluginsController.prototype[name as never]) !== undefined,
      );

    it('gates the list alone, on read:Plugin, with a guard of its own and none on the class', () => {
      expect(Reflect.getMetadata('__guards__', UserPluginsController)).toBeUndefined();
      expect(Reflect.getMetadata('__guards__', UserPluginsController.prototype.list)).toEqual([PoliciesGuard]);

      const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, UserPluginsController.prototype.list) as
        Array<(ability: AppAbility) => boolean> | undefined;
      expect(handlers).toHaveLength(1);
      const can = jest.fn().mockReturnValue(true);
      handlers?.[0]({ can } as unknown as AppAbility);
      expect(can).toHaveBeenCalledWith(Action.read, ResourceType.Plugin);

      for (const name of routes().filter((route) => route !== 'list')) {
        expect(Reflect.getMetadata(CHECK_POLICIES_KEY, UserPluginsController.prototype[name as never])).toBeUndefined();
      }
    });

    it('every route refuses a non-user actor', () => {
      for (const name of routes()) {
        auditContext.getActor.mockReturnValue({ kind: 'apiKey', userId: USER_ID, apiKeyId: 'k' } as unknown as Actor);

        // Each handler takes (slug) or (slug, dto) or (query); the kind check
        // runs before any of them are used, so the arguments are immaterial.
        expect(() =>
          (controller[name as keyof UserPluginsController] as (...args: unknown[]) => unknown).call(
            controller,
            'demo-sink',
            { manifestSha256: SHA, answers: [ANSWER], answer: ANSWER },
          ),
        ).toThrow(ForbiddenException);
      }
    });
  });

  describe('route registration', () => {
    // Same `:slug/<literal>` discipline as PluginsController. #323 extends
    // this class; its routes join this list.
    it.each([
      ['list', '/', RequestMethod.GET],
      ['consentPresentation', ':slug/consent', RequestMethod.GET],
      ['enable', ':slug/enable', RequestMethod.POST],
      ['toggleConsent', ':slug/consent/toggle', RequestMethod.POST],
      ['reviewConsent', ':slug/consent/review', RequestMethod.POST],
      ['disable', ':slug/disable', RequestMethod.POST],
      ['featureStates', ':slug/features', RequestMethod.GET],
    ] as const)('binds %s to %s', (handler, path, method) => {
      expect(Reflect.getMetadata('path', UserPluginsController.prototype[handler])).toBe(path);
      expect(Reflect.getMetadata('method', UserPluginsController.prototype[handler])).toBe(method);
    });

    it('registers exactly the consent and unit-enablement routes, with no per-permission grant route (#1150)', () => {
      const handlers = Object.getOwnPropertyNames(UserPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', UserPluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual([
        'list',
        'consentPresentation',
        'enable',
        'toggleConsent',
        'reviewConsent',
        'disable',
        'featureStates',
      ]);
    });
  });
});
