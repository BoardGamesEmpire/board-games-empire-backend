import type { Actor, AuditContextService } from '@bge/actor-context';
import { PluginGrantScope, PluginGrantStatus } from '@bge/database';
import type { PluginConsentPresentation, PluginConsentPresentationService, PluginGrantService } from '@bge/plugin';
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

describe('UserPluginsController (delegation + actor-kind floor)', () => {
  let controller: UserPluginsController;
  let grants: jest.Mocked<Pick<PluginGrantService, 'decide'>>;
  let presentation: jest.Mocked<Pick<PluginConsentPresentationService, 'presentForUnitBySlug'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale' | 'getActor'>>;

  beforeEach(() => {
    grants = { decide: jest.fn().mockResolvedValue({ grant: GRANT, changed: true }) };
    presentation = { presentForUnitBySlug: jest.fn().mockResolvedValue(PRESENTATION) };
    auditContext = {
      getLocale: jest.fn().mockReturnValue(null),
      getActor: jest.fn().mockReturnValue({ kind: 'user', userId: USER_ID } as Actor),
    };
    controller = new UserPluginsController(grants as never, presentation as never, auditContext as never);
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
  });

  describe('route registration', () => {
    // Same `:slug/<literal>` discipline as PluginsController. #323 extends
    // this class; its routes join this list.
    it.each([
      ['decideGrant', ':slug/grants', RequestMethod.POST],
      ['consentPresentation', ':slug/consent', RequestMethod.GET],
    ] as const)('binds %s to %s', (handler, path, method) => {
      expect(Reflect.getMetadata('path', UserPluginsController.prototype[handler])).toBe(path);
      expect(Reflect.getMetadata('method', UserPluginsController.prototype[handler])).toBe(method);
    });

    it('registers exactly the grant-consent routes', () => {
      const handlers = Object.getOwnPropertyNames(UserPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', UserPluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual(['decideGrant', 'consentPresentation']);
    });
  });
});
