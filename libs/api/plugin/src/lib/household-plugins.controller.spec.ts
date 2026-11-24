import type { AuditContextService } from '@bge/actor-context';
import type { DatabaseService } from '@bge/database';
import { Action, PluginGrantStatus, ResourceType, RiskLevel } from '@bge/database';
import { HouseholdLivenessGuard } from '@bge/household';
import type { SupportedLocalesService } from '@bge/i18n';
import type { AbilityService, AppAbility } from '@bge/permissions';
import { CHECK_POLICIES_KEY, PoliciesGuard, ScopeComposer } from '@bge/permissions';
import type {
  PluginConsentActService,
  PluginConsentPresentation,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginFeatureUnitState,
  PluginInventoryService,
  PluginUnitLifecycleService,
} from '@bge/plugin';
import { PluginConsentActLocaleError } from '@bge/plugin';
import { ListScopeNotComposedError } from '@bge/shared';
import type { MockAbilityService } from '@bge/testing';
import { createMockAbilityService, MOCK_ACTING_USER_ID } from '@bge/testing';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, NotFoundException, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import 'reflect-metadata';
import type { Observable } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { HouseholdPluginsController } from './household-plugins.controller';

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
const UNIT_ROW = { id: 'hp-1', householdId: 'hh-1', pluginId: 'plugin-1', enabled: true } as never;
const SHA = 'a'.repeat(64);
const ANSWER = { permissionSlug: 'update:calendar', status: PluginGrantStatus.Granted, riskLevel: RiskLevel.Medium };
const DECIDED_AT = new Date('2026-11-14T00:00:00Z');
const ACT = { id: 'act-1', kind: 'SwitchOn', decidedAt: DECIDED_AT, presentation: {} } as never;
const INVENTORY_PAGE = {
  rows: [
    {
      id: 'plugin-1',
      slug: 'demo-sink',
      serverEnabled: true,
      unit: {
        anchored: true,
        enabled: true,
        state: 'review_pending',
        dormancy: null,
        consent: {
          outstanding: [
            {
              slug: 'update:calendar',
              kind: 'never_asked',
              required: true,
              feature: null,
              riskLevel: 'Medium',
              reason: 'Lets the plugin change the household calendar',
            },
          ],
          optionalOff: [],
        },
      },
    },
  ],
  total: 1,
};
const FEATURE_STATE = {
  plugin: { id: 'plugin-1', slug: 'demo-sink' },
  unit: { scopeType: 'Household', householdId: 'hh-1' },
  served: true,
  serverEnabled: true,
  state: 'review_pending',
  dormancy: null,
  consent: {
    outstanding: [
      {
        slug: 'update:calendar',
        kind: 'never_asked',
        required: true,
        feature: null,
        riskLevel: 'Medium',
        reason: 'Lets the plugin change the household calendar',
      },
    ],
    optionalOff: [],
  },
  features: [],
} as unknown as PluginFeatureUnitState;

describe('HouseholdPluginsController (delegation + household instance gate)', () => {
  let controller: HouseholdPluginsController;
  let consentActs: jest.Mocked<Pick<PluginConsentActService, 'switchOn' | 'toggle' | 'review'>>;
  let presentation: jest.Mocked<
    Pick<PluginConsentPresentationService, 'presentForUnitBySlug' | 'presentStagedForUnitBySlug'>
  >;
  let units: jest.Mocked<Pick<PluginUnitLifecycleService, 'disableHousehold' | 'updateHouseholdConfig'>>;
  let featureState: jest.Mocked<Pick<PluginFeatureStateService, 'resolveForUnitBySlug'>>;
  let inventory: jest.Mocked<Pick<PluginInventoryService, 'listForHousehold'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale'>>;
  let abilityService: MockAbilityService;
  let householdCount: jest.Mock;
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
      consentActs as never,
      abilityService as never,
      presentation as never,
      units as never,
      featureState as never,
      inventory as never,
      auditContext as never,
      { household: { count: householdCount } } as unknown as DatabaseService,
      scopeComposer,
      { getSupportedTags: () => ['en', 'de'] } as unknown as SupportedLocalesService,
    );
  });

  afterEach(() => jest.clearAllMocks());

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

  it('serves the staged consent surface when asked (#1150)', async () => {
    const result = await firstValueFrom(controller.consentPresentation('hh-1', 'demo-sink', { manifest: 'staged' }));

    // The household pre-consents from the staged update's consent surface.
    expect(presentation.presentStagedForUnitBySlug).toHaveBeenCalledWith(
      'demo-sink',
      { scopeType: 'Household', householdId: 'hh-1' },
      undefined,
    );
    expect(presentation.presentForUnitBySlug).not.toHaveBeenCalled();
    expect(result).toEqual({ presentation: STAGED_PRESENTATION });
  });

  // The three consent act routes (#1150): each hands the service the route
  // household as the unit, the acting user, the sha and the answers the client
  // read from the consent surface, and the locale it was shown in.
  describe('consent acts (#1150)', () => {
    const unit = { scopeType: 'Household', householdId: 'hh-1' };
    const actBody = { id: 'act-1', kind: 'SwitchOn', decidedAt: DECIDED_AT };

    it('enable switches the plugin on with the unit, the actor, the sha, the answers, the config and the locale (#1150)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(
        controller.enable('hh-1', 'demo-sink', {
          manifestSha256: SHA,
          answers: [ANSWER],
          config: { webhookUrl: 'https://x' },
        }),
      );

      expect(consentActs.switchOn).toHaveBeenCalledWith({
        slug: 'demo-sink',
        unit,
        actorId: MOCK_ACTING_USER_ID,
        manifestSha256: SHA,
        answers: [ANSWER],
        config: { webhookUrl: 'https://x' },
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
        controller.toggleConsent('hh-1', 'demo-sink', { manifestSha256: SHA, answer: ANSWER }),
      );

      expect(consentActs.toggle).toHaveBeenCalledWith({
        slug: 'demo-sink',
        unit,
        actorId: MOCK_ACTING_USER_ID,
        manifestSha256: SHA,
        answers: [ANSWER],
        locale: 'de',
      });
      expect(result).toEqual(
        expect.objectContaining({
          message: expect.objectContaining({ key: 'success.plugin.consent_recorded', args: { slug: 'demo-sink' } }),
          changed: true,
        }),
      );
    });

    it('review records the answers with the unit, the actor, the sha and the locale (#1150)', async () => {
      const result = await firstValueFrom(
        controller.reviewConsent('hh-1', 'demo-sink', { manifestSha256: SHA, answers: [ANSWER] }),
      );

      expect(consentActs.review).toHaveBeenCalledWith({
        slug: 'demo-sink',
        unit,
        actorId: MOCK_ACTING_USER_ID,
        manifestSha256: SHA,
        answers: [ANSWER],
        locale: undefined,
      });
      expect(result).toEqual(
        expect.objectContaining({
          message: expect.objectContaining({ key: 'success.plugin.consent_recorded' }),
          act: actBody,
        }),
      );
    });

    it('a review that switched the unit off answers with the switched-off message (#1150)', async () => {
      consentActs.review.mockResolvedValue({ act: ACT, changed: true, unit: UNIT_ROW, switchedOff: true });

      const result = await firstValueFrom(
        controller.reviewConsent('hh-1', 'demo-sink', { manifestSha256: SHA, answers: [ANSWER] }),
      );

      expect(result).toEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            key: 'success.plugin.consent_refused_switched_off',
            args: { slug: 'demo-sink' },
          }),
          switchedOff: true,
        }),
      );
    });

    it('an act that changes nothing answers changed false and no act (#1150)', async () => {
      consentActs.toggle.mockResolvedValue({ act: null, changed: false, unit: UNIT_ROW, switchedOff: false });

      const result = await firstValueFrom(
        controller.toggleConsent('hh-1', 'demo-sink', { manifestSha256: SHA, answer: ANSWER }),
      );

      expect(result).toEqual(expect.objectContaining({ changed: false, act: null, unit: UNIT_ROW }));
    });

    it("the household routes refuse an actor who cannot manage this household's plugins before the service is called (#1150)", () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      expect(() => controller.enable('hh-other', 'demo-sink', { manifestSha256: SHA, answers: [] })).toThrow(
        ForbiddenException,
      );
      expect(() => controller.toggleConsent('hh-other', 'demo-sink', { manifestSha256: SHA, answer: ANSWER })).toThrow(
        ForbiddenException,
      );
      expect(() =>
        controller.reviewConsent('hh-other', 'demo-sink', { manifestSha256: SHA, answers: [ANSWER] }),
      ).toThrow(ForbiddenException);

      expect(abilityService.assertCurrentActorCan).toHaveBeenCalledWith(Action.manage, ResourceType.HouseholdPlugin, {
        householdId: 'hh-other',
      });
      expect(consentActs.switchOn).not.toHaveBeenCalled();
      expect(consentActs.toggle).not.toHaveBeenCalled();
      expect(consentActs.review).not.toHaveBeenCalled();
    });

    // The act stores what the consent surface showed, so it renders in the
    // locale the body names rather than the one this request resolved (#1301).
    it('each act renders in the supported locale the body names, not the request locale (#1301)', async () => {
      auditContext.getLocale.mockReturnValue('en');

      await firstValueFrom(controller.enable('hh-1', 'demo-sink', { manifestSha256: SHA, answers: [], locale: 'de' }));
      await firstValueFrom(
        controller.toggleConsent('hh-1', 'demo-sink', { manifestSha256: SHA, answer: ANSWER, locale: 'de' }),
      );
      await firstValueFrom(
        controller.reviewConsent('hh-1', 'demo-sink', { manifestSha256: SHA, answers: [ANSWER], locale: 'de' }),
      );

      expect(consentActs.switchOn).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }));
      expect(consentActs.toggle).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }));
      expect(consentActs.review).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }));
    });

    it('each act refuses a locale the server does not support before the service is called (#1301)', () => {
      expect(() => controller.enable('hh-1', 'demo-sink', { manifestSha256: SHA, answers: [], locale: 'xx' })).toThrow(
        PluginConsentActLocaleError,
      );
      expect(() =>
        controller.toggleConsent('hh-1', 'demo-sink', { manifestSha256: SHA, answer: ANSWER, locale: 'xx' }),
      ).toThrow(PluginConsentActLocaleError);
      expect(() =>
        controller.reviewConsent('hh-1', 'demo-sink', { manifestSha256: SHA, answers: [ANSWER], locale: 'xx' }),
      ).toThrow(PluginConsentActLocaleError);
      expect(consentActs.switchOn).not.toHaveBeenCalled();
      expect(consentActs.toggle).not.toHaveBeenCalled();
      expect(consentActs.review).not.toHaveBeenCalled();
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

    it('binds every #323 write and read to ITS household before the service is asked', async () => {
      abilityService.assertCurrentActorCan.mockImplementation(() => {
        throw new ForbiddenException();
      });

      expect(() => controller.enable('hh-other', 'demo-sink', { manifestSha256: SHA, answers: [] })).toThrow(
        ForbiddenException,
      );
      expect(() => controller.disable('hh-other', 'demo-sink')).toThrow(ForbiddenException);
      expect(() => controller.updateConfig('hh-other', 'demo-sink', { config: {} })).toThrow(ForbiddenException);
      expect(() => controller.featureStates('hh-other', 'demo-sink')).toThrow(ForbiddenException);

      expect(consentActs.switchOn).not.toHaveBeenCalled();
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
    // households, such as a household member's key scoped to the plugin routes
    // whose owner's cached graph still holds a deleted household's membership
    // (#266), and a soft delete leaves the plugin rows in place. The list
    // checks for that actor itself, and answers 403, as the routes do whatever
    // the id.
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
  // either, so a household member's key scoped to the plugin routes, whose
  // owner's cached graph still holds the deleted household's membership
  // (#266), would read its decisions through them. They check it as the list
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

    it.each([
      'list',
      'consentPresentation',
      'enable',
      'toggleConsent',
      'reviewConsent',
      'disable',
      'updateConfig',
      'featureStates',
    ])('probes the route household on %s, and answers 404 when it is gone', async (handler) => {
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
    });
  });

  describe('policy gates', () => {
    const policiesFor = (handler: string) =>
      Reflect.getMetadata(CHECK_POLICIES_KEY, HouseholdPluginsController.prototype[handler as never]) as
        Array<(ability: AppAbility) => boolean> | undefined;

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
      ['enable', Action.manage],
      ['toggleConsent', Action.manage],
      ['reviewConsent', Action.manage],
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
      ['consentPresentation', ':slug/consent', RequestMethod.GET],
      ['enable', ':slug/enable', RequestMethod.POST],
      ['toggleConsent', ':slug/consent/toggle', RequestMethod.POST],
      ['reviewConsent', ':slug/consent/review', RequestMethod.POST],
      ['disable', ':slug/disable', RequestMethod.POST],
      ['updateConfig', ':slug/config', RequestMethod.PATCH],
      ['featureStates', ':slug/features', RequestMethod.GET],
    ] as const)('binds %s to %s', (handler, path, method) => {
      expect(Reflect.getMetadata('path', HouseholdPluginsController.prototype[handler])).toBe(path);
      expect(Reflect.getMetadata('method', HouseholdPluginsController.prototype[handler])).toBe(method);
    });

    it('registers exactly the consent and unit-enablement routes, with no per-permission grant route (#1150)', () => {
      const handlers = Object.getOwnPropertyNames(HouseholdPluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', HouseholdPluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual([
        'list',
        'consentPresentation',
        'enable',
        'toggleConsent',
        'reviewConsent',
        'disable',
        'updateConfig',
        'featureStates',
      ]);
    });
  });
});
