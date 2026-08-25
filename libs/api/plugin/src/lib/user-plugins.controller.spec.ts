import type { Actor, AuditContextService } from '@bge/actor-context';
import { PluginGrantScope, PluginGrantStatus } from '@bge/database';
import { CHECK_POLICIES_KEY } from '@bge/permissions';
import type {
  PluginConsentPresentation,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginFeatureUnitState,
  PluginGrantService,
  PluginInventoryService,
  PluginUnitLifecycleService,
} from '@bge/plugin';
import { ForbiddenException, RequestMethod } from '@nestjs/common';
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
const GRANT = { id: 'grant-1', permissionSlug: 'read:public_content', status: PluginGrantStatus.Granted } as never;
const UNIT_ROW = { id: 'up-1', userId: USER_ID, pluginId: 'plugin-1', enabled: true } as never;
const INVENTORY_PAGE = {
  rows: [{ id: 'plugin-1', slug: 'demo-sink', serverEnabled: true, unit: { anchored: false } }],
  total: 1,
};
const FEATURE_STATE = {
  plugin: { id: 'plugin-1', slug: 'demo-sink' },
  unit: { scopeType: 'User', userId: USER_ID },
  served: true,
  suspendedForConsent: false,
  features: [],
} as unknown as PluginFeatureUnitState;

describe('UserPluginsController (delegation + actor-kind floor)', () => {
  let controller: UserPluginsController;
  let grants: jest.Mocked<Pick<PluginGrantService, 'decide'>>;
  let presentation: jest.Mocked<Pick<PluginConsentPresentationService, 'presentForUnitBySlug'>>;
  let units: jest.Mocked<Pick<PluginUnitLifecycleService, 'enableUser' | 'disableUser'>>;
  let featureState: jest.Mocked<Pick<PluginFeatureStateService, 'resolveForUnitBySlug'>>;
  let inventory: jest.Mocked<Pick<PluginInventoryService, 'listForUser'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale' | 'getActor'>>;

  beforeEach(() => {
    grants = { decide: jest.fn().mockResolvedValue({ grant: GRANT, changed: true }) };
    presentation = { presentForUnitBySlug: jest.fn().mockResolvedValue(PRESENTATION) };
    units = {
      enableUser: jest.fn().mockResolvedValue(UNIT_ROW),
      disableUser: jest.fn().mockResolvedValue(UNIT_ROW),
    };
    featureState = { resolveForUnitBySlug: jest.fn().mockResolvedValue(FEATURE_STATE) };
    inventory = { listForUser: jest.fn().mockResolvedValue(INVENTORY_PAGE as never) };
    auditContext = {
      getLocale: jest.fn().mockReturnValue(null),
      getActor: jest.fn().mockReturnValue({ kind: 'user', userId: USER_ID } as Actor),
    };
    controller = new UserPluginsController(
      grants as never,
      presentation as never,
      units as never,
      featureState as never,
      inventory as never,
      auditContext as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('decideGrant addresses the session user as BOTH decider and unit — no other user is addressable', async () => {
    const result = await firstValueFrom(
      controller.decideGrant('demo-sink', {
        permissionSlug: 'read:public_content',
        status: PluginGrantStatus.Granted,
      }),
    );

    expect(grants.decide).toHaveBeenCalledWith({
      slug: 'demo-sink',
      scopeType: PluginGrantScope.User,
      scopeId: USER_ID,
      permissionSlug: 'read:public_content',
      status: PluginGrantStatus.Granted,
      deciderId: USER_ID,
    });
    expect(result).toEqual({
      message: expect.objectContaining({
        key: 'success.plugin.grant_decided',
        args: { slug: 'demo-sink', permissionSlug: 'read:public_content' },
      }),
      grant: GRANT,
      changed: true,
    });
  });

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

  it('an unresolved CLS locale is passed as undefined — the presentation falls back to the default locale', async () => {
    auditContext.getLocale.mockReturnValue(null);

    await firstValueFrom(controller.consentPresentation('demo-sink'));

    expect(presentation.presentForUnitBySlug).toHaveBeenCalledWith(
      'demo-sink',
      { scopeType: 'User', userId: USER_ID },
      undefined,
    );
  });

  it('enable/disable address the session user only, and render the unit with the shared success keys', async () => {
    const enabled = await firstValueFrom(controller.enable('demo-sink'));

    expect(units.enableUser).toHaveBeenCalledWith({ slug: 'demo-sink', userId: USER_ID });
    expect(enabled).toEqual({
      message: expect.objectContaining({ key: 'success.plugin.enabled', args: { slug: 'demo-sink' } }),
      unit: UNIT_ROW,
    });

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
   * The actor-kind floor: no permission seed exists for this axis (D-BA
   * seeded server + household pairs only), so there is no ability for
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
    ] as const)('refuses a %s actor on decide — before the service is even asked', (_kind, actor) => {
      auditContext.getActor.mockReturnValue(actor as unknown as Actor);

      expect(() =>
        controller.decideGrant('demo-sink', {
          permissionSlug: 'read:public_content',
          status: PluginGrantStatus.Granted,
        }),
      ).toThrow(ForbiddenException);
      expect(grants.decide).not.toHaveBeenCalled();
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
      ['enable', () => controller.enable('demo-sink')],
      ['disable', () => controller.disable('demo-sink')],
      ['featureStates', () => controller.featureStates('demo-sink')],
    ] as const)('the floor holds on the #323 %s route too — before the service is asked', (_name, invoke) => {
      auditContext.getActor.mockReturnValue({ kind: 'apiKey', userId: USER_ID, apiKeyId: 'key-1' } as unknown as Actor);

      expect(invoke).toThrow(ForbiddenException);
      expect(units.enableUser).not.toHaveBeenCalled();
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

      expect(inventory.listForUser).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ skip: 0, pageSize: 25 }), {
        includeUninstalled: undefined,
        locale: 'de',
      });
      expect(result).toEqual({
        plugins: INVENTORY_PAGE.rows,
        pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false },
      });
    });

    // The actor-KIND floor, not a permission check: with no seed for this
    // axis there is nothing for PoliciesGuard to clamp an API key against, so
    // a key acting as its owner must not read the owner's consent surface.
    it('refuses a non-user actor before touching the service', () => {
      auditContext.getActor.mockReturnValue({ kind: 'apiKey', apiKeyId: 'key-1' } as unknown as Actor);

      expect(() => controller.list(query())).toThrow(ForbiddenException);
      expect(inventory.listForUser).not.toHaveBeenCalled();
    });
  });

  // This axis has no permission seed (D-BA seeded only the server and
  // household pairs), so PoliciesGuard is deliberately absent and the gate is
  // the actor KIND. Pinned both ways: no route may quietly acquire a CASL gate
  // that would have nothing to clamp, and none may skip the kind check.
  describe('gate shape', () => {
    const routes = () =>
      Object.getOwnPropertyNames(UserPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', UserPluginsController.prototype[name as never]) !== undefined,
      );

    it('declares no CASL policies and no class-level PoliciesGuard', () => {
      expect(Reflect.getMetadata('__guards__', UserPluginsController)).toBeUndefined();

      for (const name of routes()) {
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
            { permissionSlug: 'read:public_content', status: PluginGrantStatus.Granted },
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
      ['decideGrant', ':slug/grants', RequestMethod.POST],
      ['consentPresentation', ':slug/consent', RequestMethod.GET],
      ['enable', ':slug/enable', RequestMethod.POST],
      ['disable', ':slug/disable', RequestMethod.POST],
      ['featureStates', ':slug/features', RequestMethod.GET],
    ] as const)('binds %s to %s', (handler, path, method) => {
      expect(Reflect.getMetadata('path', UserPluginsController.prototype[handler])).toBe(path);
      expect(Reflect.getMetadata('method', UserPluginsController.prototype[handler])).toBe(method);
    });

    it('registers exactly the grant-consent and unit-enablement routes', () => {
      const handlers = Object.getOwnPropertyNames(UserPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', UserPluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual(['list', 'decideGrant', 'consentPresentation', 'enable', 'disable', 'featureStates']);
    });
  });
});
