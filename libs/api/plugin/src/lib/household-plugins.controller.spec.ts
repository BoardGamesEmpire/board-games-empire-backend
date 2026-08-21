import type { AuditContextService } from '@bge/actor-context';
import { Action, PluginGrantScope, PluginGrantStatus } from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import type { PluginConsentPresentation, PluginConsentPresentationService, PluginGrantService } from '@bge/plugin';
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

describe('HouseholdPluginsController (delegation + household instance gate)', () => {
  let controller: HouseholdPluginsController;
  let grants: jest.Mocked<Pick<PluginGrantService, 'decide'>>;
  let presentation: jest.Mocked<Pick<PluginConsentPresentationService, 'presentForUnitBySlug'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale'>>;
  let abilityService: MockAbilityService;
  let can: jest.Mock;

  beforeEach(() => {
    grants = { decide: jest.fn().mockResolvedValue({ grant: GRANT, changed: true }) };
    presentation = { presentForUnitBySlug: jest.fn().mockResolvedValue(PRESENTATION) };
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

  describe('route registration', () => {
    // Same `:slug/<literal>` discipline as PluginsController — pinned so a
    // future plain `:slug` or literal sibling must revisit ordering
    // deliberately. #323 extends this class; its routes join this list.
    it.each([
      ['decideGrant', ':slug/grants', RequestMethod.POST],
      ['consentPresentation', ':slug/consent', RequestMethod.GET],
    ] as const)('binds %s to %s', (handler, path, method) => {
      expect(Reflect.getMetadata('path', HouseholdPluginsController.prototype[handler])).toBe(path);
      expect(Reflect.getMetadata('method', HouseholdPluginsController.prototype[handler])).toBe(method);
    });

    it('registers exactly the grant-consent routes', () => {
      const handlers = Object.getOwnPropertyNames(HouseholdPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', HouseholdPluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual(['decideGrant', 'consentPresentation']);
    });
  });
});
