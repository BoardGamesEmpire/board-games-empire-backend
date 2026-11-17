import type { AuditContextService } from '@bge/actor-context';
import { SERVER_PLUGIN_UNIT } from '@bge/actor-context';
import {
  Action,
  deriveReadCeilings,
  PERMISSION_CATALOG,
  PluginGrantStatus,
  ResourceType,
  RiskLevel,
  ROLE_PERMISSION_CATALOG,
} from '@bge/database';
import type { SupportedLocalesService } from '@bge/i18n';
import { CHECK_POLICIES_KEY, ScopeComposer, type AppAbility } from '@bge/permissions';
import type {
  PluginConsentPresentation,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginFeatureUnitState,
  PluginInventoryService,
  PluginLifecycleService,
  PluginServerConsentActService,
  PluginUpdateService,
  UpdateEscalationComparison,
} from '@bge/plugin';
import {
  PluginConsentActLocaleError,
  PluginConsentPresentationNotFoundError,
  PluginFeatureStateNotFoundError,
  PluginInventoryNotFoundError,
  PluginLifecycleNotFoundError,
  PluginUnitPluginNotFoundError,
  PluginUpdateNoPendingError,
  PluginUpdatePluginNotFoundError,
} from '@bge/plugin';
import { ListScopeNotComposedError } from '@bge/shared';
import {
  createMockAbilityService,
  MOCK_ACTING_USER_ID,
  shippedReadReaches,
  type MockAbilityService,
} from '@bge/testing';
import { RequestMethod } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import 'reflect-metadata';
import { firstValueFrom, type Observable } from 'rxjs';
import { PluginsController, SERVER_PLUGIN_LIST_SCOPE } from './plugins.controller';
import { SERVER_PLUGIN_COLUMN } from './policies/read-server-plugins.policy';

const PLUGIN = { id: 'plugin-1', slug: 'demo-sink', enabled: true } as never;
const AFFECTED_UNITS = [{ scopeType: 'Household', householdId: 'hh-1' }] as never[];

const APPROVED_PLUGIN = { id: 'plugin-1', slug: 'demo-sink', version: '1.3.0', restartRequired: true } as never;
const COMPARISON = {
  escalations: [],
  serverGating: true,
  deniedRequiredSlugs: ['read:household'],
} as unknown as UpdateEscalationComparison;
const SEEDED_GRANTS = [{ id: 'grant-1', permissionSlug: 'user:impersonate' }] as never[];
const APPROVE_ACT = {
  id: 'act-1',
  kind: 'UpdateApprove',
  decidedAt: new Date('2026-11-16T00:00:00Z'),
  presentation: { locale: 'de', source: 'staged', checks: [] },
  manifestSha256: 'f'.repeat(64),
};
const RECONSENT_HOUSEHOLDS = [{ householdId: 'hh-1', outstanding: ['calendar:read'] }];
const PENDING_PLUGIN = {
  id: 'plugin-1',
  slug: 'demo-sink',
  enabled: true,
  version: '1.2.0',
  pendingVersion: '1.3.0',
  pendingStagingId: 'staging-a',
} as never;
const DECLARES = { added: ['plugin|demo-sink|manage:digest'], removed: ['plugin|demo-sink|read:legacy'] };
const NO_LONGER_REQUESTED = ['feedback:read'];
const UNIT_ANSWERS = { household: { switchedOn: 3, covered: 1 }, user: { switchedOn: 2, covered: 2 } };
const PRESENTATION = {
  plugin: { id: 'plugin-1', slug: 'demo-sink', enabled: true },
  manifestVersion: '1.3.0',
  source: 'staged',
  checks: [],
} as unknown as PluginConsentPresentation;
const ACTIVE_PRESENTATION = {
  plugin: { id: 'plugin-1', slug: 'demo-sink', enabled: true },
  manifestVersion: '1.2.0',
  source: 'active',
  checks: [],
} as unknown as PluginConsentPresentation;
const SHA = 'b'.repeat(64);
const ANSWER = {
  permissionSlug: 'read:safe_http_policy',
  status: PluginGrantStatus.Granted,
  riskLevel: RiskLevel.Medium,
};
const DECIDED_AT = new Date('2026-11-16T00:00:00Z');
const ACT = { id: 'act-1', kind: 'Toggle', decidedAt: DECIDED_AT, presentation: {} } as never;
const INVENTORY_PAGE = {
  rows: [{ id: 'plugin-1', slug: 'demo-sink', displayName: 'Demo Sink', manifestUnreadable: false }],
  total: 1,
};
const DETAIL = { id: 'plugin-1', slug: 'demo-sink', executionMode: 'InProcess', features: [] } as never;
const FEATURE_STATE = {
  plugin: { id: 'plugin-1', slug: 'demo-sink' },
  unit: SERVER_PLUGIN_UNIT,
  served: true,
  serverEnabled: true,
  state: 'on',
  dormancy: null,
  consent: { outstanding: [], optionalOff: [] },
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
  let featureState: jest.Mocked<Pick<PluginFeatureStateService, 'resolveForUnitBySlug'>>;
  let inventory: jest.Mocked<Pick<PluginInventoryService, 'listForServer' | 'getBySlug' | 'existsUnderCeiling'>>;
  let serverConsentActs: jest.Mocked<Pick<PluginServerConsentActService, 'toggle' | 'review'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getLocale'>>;
  let abilityService: MockAbilityService;
  let scopeComposer: ScopeComposer;

  // Every `:slug` route sits in exactly one of these tables. The read and
  // write describes below pin each one's ceiling check and its unknown-slug
  // error, and `route registration` fails a `:slug` route in neither (#985).
  // The closures read the controller and the mocks lazily, at call time.
  const reads = [
    {
      route: 'getBySlug',
      call: (): Observable<unknown> => controller.getBySlug('demo-sink'),
      service: () => inventory.getBySlug,
      notFound: PluginInventoryNotFoundError,
      slugField: 'pluginSlug',
    },
    {
      route: 'consentPresentation',
      call: (): Observable<unknown> => controller.consentPresentation('demo-sink'),
      service: () => presentation.presentForUnitBySlug,
      notFound: PluginConsentPresentationNotFoundError,
      slugField: 'pluginSlug',
    },
    {
      route: 'pendingUpdate',
      call: (): Observable<unknown> => controller.pendingUpdate('demo-sink'),
      service: () => updates.describePending,
      notFound: PluginUpdatePluginNotFoundError,
      slugField: 'slug',
    },
    {
      route: 'featureStates',
      call: (): Observable<unknown> => controller.featureStates('demo-sink'),
      service: () => featureState.resolveForUnitBySlug,
      notFound: PluginFeatureStateNotFoundError,
      slugField: 'pluginSlug',
    },
  ];

  const writes = [
    {
      route: 'toggleConsent',
      call: (): Observable<unknown> => controller.toggleConsent('demo-sink', { manifestSha256: SHA, answer: ANSWER }),
      service: () => serverConsentActs.toggle,
      notFound: PluginUnitPluginNotFoundError,
      slugField: 'pluginSlug',
    },
    {
      route: 'reviewConsent',
      call: (): Observable<unknown> =>
        controller.reviewConsent('demo-sink', { manifestSha256: SHA, answers: [ANSWER] }),
      service: () => serverConsentActs.review,
      notFound: PluginUnitPluginNotFoundError,
      slugField: 'pluginSlug',
    },
    {
      route: 'enable',
      call: (): Observable<unknown> => controller.enable('demo-sink'),
      service: () => lifecycle.enable,
      notFound: PluginLifecycleNotFoundError,
      slugField: 'slug',
    },
    {
      route: 'disable',
      call: (): Observable<unknown> => controller.disable('demo-sink'),
      service: () => lifecycle.disable,
      notFound: PluginLifecycleNotFoundError,
      slugField: 'slug',
    },
    {
      route: 'updateConfig',
      call: (): Observable<unknown> => controller.updateConfig('demo-sink', { config: {} }),
      service: () => lifecycle.updateConfig,
      notFound: PluginLifecycleNotFoundError,
      slugField: 'slug',
    },
    {
      route: 'uninstall',
      call: (): Observable<unknown> => controller.uninstall('demo-sink', {}),
      service: () => lifecycle.uninstall,
      notFound: PluginLifecycleNotFoundError,
      slugField: 'slug',
    },
    {
      route: 'approveUpdate',
      call: (): Observable<unknown> => controller.approveUpdate('demo-sink', { stagingId: 'staging-a' }),
      service: () => updates.approve,
      notFound: PluginUpdatePluginNotFoundError,
      slugField: 'slug',
    },
    {
      route: 'rejectUpdate',
      call: (): Observable<unknown> => controller.rejectUpdate('demo-sink', { stagingId: 'staging-a' }),
      service: () => updates.reject,
      notFound: PluginUpdatePluginNotFoundError,
      slugField: 'slug',
    },
  ];

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
        act: APPROVE_ACT,
        seededGrants: SEEDED_GRANTS,
        reconsentHouseholdUnits: RECONSENT_HOUSEHOLDS,
        reconsentUserUnits: [],
      }),
      reject: jest.fn().mockResolvedValue(PLUGIN),
      describePending: jest.fn().mockResolvedValue({
        plugin: PENDING_PLUGIN,
        comparison: COMPARISON,
        pendingSince: new Date('2026-07-29T00:00:00Z'),
        declares: DECLARES,
        noLongerRequested: NO_LONGER_REQUESTED,
        unitAnswers: UNIT_ANSWERS,
      }),
    };
    presentation = {
      presentPendingFromRow: jest.fn().mockResolvedValue(PRESENTATION),
      presentForUnitBySlug: jest.fn().mockResolvedValue(ACTIVE_PRESENTATION),
    };
    featureState = { resolveForUnitBySlug: jest.fn().mockResolvedValue(FEATURE_STATE) };
    inventory = {
      listForServer: jest.fn().mockResolvedValue(INVENTORY_PAGE as never),
      getBySlug: jest.fn().mockResolvedValue(DETAIL),
      // Every slug here lies under the actor's ceiling unless a test says
      // otherwise.
      existsUnderCeiling: jest.fn().mockResolvedValue(true),
    };
    serverConsentActs = {
      toggle: jest.fn().mockResolvedValue({ act: ACT, changed: true }),
      review: jest.fn().mockResolvedValue({ act: ACT, changed: true }),
    };
    auditContext = { getLocale: jest.fn().mockReturnValue(null) };
    abilityService = createMockAbilityService();
    // The REAL composer over the mocked ability service, so the list's ceiling
    // is composed and recorded as it is in a request.
    scopeComposer = new ScopeComposer(abilityService as never);
    controller = new PluginsController(
      lifecycle as never,
      abilityService as never,
      updates as never,
      presentation as never,
      featureState as never,
      inventory as never,
      serverConsentActs as never,
      auditContext as never,
      scopeComposer,
      { getSupportedTags: () => ['en', 'de'] } as unknown as SupportedLocalesService,
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
    it('approveUpdate forwards slug, actor, the confirmation set and the locale; the response surfaces the act and the consequences (#1336)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(
        controller.approveUpdate('demo-sink', { stagingId: 'staging-a', confirmCriticalSlugs: ['user:impersonate'] }),
      );

      expect(updates.approve).toHaveBeenCalledWith({
        slug: 'demo-sink',
        approverId: MOCK_ACTING_USER_ID,
        stagingId: 'staging-a',
        confirmCriticalSlugs: ['user:impersonate'],
        locale: 'de',
      });
      expect(result).toEqual({
        message: expect.objectContaining({
          key: 'success.plugin.update_approved',
          args: { slug: 'demo-sink', version: '1.3.0' },
        }),
        plugin: APPROVED_PLUGIN,
        comparison: COMPARISON,
        // The act's summary, not its stored presentation.
        act: { id: 'act-1', kind: 'UpdateApprove', decidedAt: new Date('2026-11-16T00:00:00Z') },
        seededGrants: SEEDED_GRANTS,
        restartRequired: true,
        reconsentHouseholdUnits: RECONSENT_HOUSEHOLDS,
        reconsentUserUnits: [],
      });
    });

    it('an omitted confirmation set and an absent locale stay undefined — the service owns the expectation and the default', async () => {
      await firstValueFrom(controller.approveUpdate('demo-sink', { stagingId: 'staging-a' }));

      expect(updates.approve).toHaveBeenCalledWith({
        slug: 'demo-sink',
        approverId: MOCK_ACTING_USER_ID,
        stagingId: 'staging-a',
        confirmCriticalSlugs: undefined,
        locale: undefined,
      });
    });

    // The approval's consent act stores what the staged-update read showed,
    // so it renders in the locale the body names (#1301).
    it('approveUpdate renders in the supported locale the body names, not the request locale (#1301)', async () => {
      auditContext.getLocale.mockReturnValue('en');

      await firstValueFrom(controller.approveUpdate('demo-sink', { stagingId: 'staging-a', locale: 'de' }));

      expect(updates.approve).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }));
    });

    it('approveUpdate refuses a locale the server does not support before the service is called (#1301)', async () => {
      await expect(
        firstValueFrom(controller.approveUpdate('demo-sink', { stagingId: 'staging-a', locale: 'xx' })),
      ).rejects.toBeInstanceOf(PluginConsentActLocaleError);
      expect(updates.approve).not.toHaveBeenCalled();
    });

    it('rejectUpdate forwards slug, actorId and the staging it answers, wrapping with a success message (#357)', async () => {
      const result = await firstValueFrom(controller.rejectUpdate('demo-sink', { stagingId: 'staging-a' }));

      expect(updates.reject).toHaveBeenCalledWith({
        slug: 'demo-sink',
        rejectorId: MOCK_ACTING_USER_ID,
        stagingId: 'staging-a',
      });
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
        // What approve and reject must send back, so neither answers a
        // staging the admin wasn't shown (#357).
        stagingId: 'staging-a',
        escalations: COMPARISON.escalations,
        serverGating: true,
        // The denied permissions approving would grant (#1336).
        deniedRequiredSlugs: ['read:household'],
        // Per scope, the switched-on units and the ones approving would ask
        // nothing of (#1336).
        unitAnswers: UNIT_ANSWERS,
        // The catalog diff rides the body: no escalation kind describes a
        // declaration change, so a client cannot reconstruct it.
        declares: DECLARES,
        // So does the other destructive half: approving deletes every
        // decision on a permission the update stops requesting (#577).
        noLongerRequested: NO_LONGER_REQUESTED,
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

  describe('consent presentation (#322)', () => {
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

  // The Server unit's consent acts (#1336): the server admin is the actor,
  // resolved from CLS, and the service re-verifies that authority.
  describe('server consent acts (#1336)', () => {
    const actBody = { id: 'act-1', kind: 'Toggle', decidedAt: DECIDED_AT };

    it('toggle records one answer with the actor, the sha and the locale (#1336)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      const result = await firstValueFrom(
        controller.toggleConsent('demo-sink', { manifestSha256: SHA, answer: ANSWER }),
      );

      expect(serverConsentActs.toggle).toHaveBeenCalledWith({
        slug: 'demo-sink',
        actorId: MOCK_ACTING_USER_ID,
        manifestSha256: SHA,
        answers: [ANSWER],
        locale: 'de',
      });
      expect(result).toEqual({
        message: expect.objectContaining({ key: 'success.plugin.server_consent_toggled', args: { slug: 'demo-sink' } }),
        changed: true,
        act: actBody,
      });
    });

    it('review records the answers with the actor, the sha and the locale (#1336)', async () => {
      const result = await firstValueFrom(
        controller.reviewConsent('demo-sink', { manifestSha256: SHA, answers: [ANSWER] }),
      );

      expect(serverConsentActs.review).toHaveBeenCalledWith({
        slug: 'demo-sink',
        actorId: MOCK_ACTING_USER_ID,
        manifestSha256: SHA,
        answers: [ANSWER],
        locale: undefined,
      });
      expect(result).toEqual({
        message: expect.objectContaining({
          key: 'success.plugin.server_consent_reviewed',
          args: { slug: 'demo-sink' },
        }),
        changed: true,
        act: actBody,
      });
    });

    it('an act that changed nothing answers changed: false with no act (#1336)', async () => {
      serverConsentActs.toggle.mockResolvedValue({ act: null, changed: false });

      const result = await firstValueFrom(
        controller.toggleConsent('demo-sink', { manifestSha256: SHA, answer: ANSWER }),
      );

      expect(result).toEqual(expect.objectContaining({ changed: false, act: null }));
    });

    // The act stores what the consent surface showed, so it renders in the
    // locale the body names rather than the one this request resolved (#1301).
    it('toggle and review render in the supported locale the body names, not the request locale (#1301)', async () => {
      auditContext.getLocale.mockReturnValue('en');

      await firstValueFrom(
        controller.toggleConsent('demo-sink', { manifestSha256: SHA, answer: ANSWER, locale: 'de' }),
      );
      await firstValueFrom(
        controller.reviewConsent('demo-sink', { manifestSha256: SHA, answers: [ANSWER], locale: 'de' }),
      );

      expect(serverConsentActs.toggle).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }));
      expect(serverConsentActs.review).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de' }));
    });

    it('toggle and review refuse a locale the server does not support before the service is called (#1301)', async () => {
      await expect(
        firstValueFrom(controller.toggleConsent('demo-sink', { manifestSha256: SHA, answer: ANSWER, locale: 'xx' })),
      ).rejects.toBeInstanceOf(PluginConsentActLocaleError);
      await expect(
        firstValueFrom(controller.reviewConsent('demo-sink', { manifestSha256: SHA, answers: [ANSWER], locale: 'xx' })),
      ).rejects.toBeInstanceOf(PluginConsentActLocaleError);
      expect(serverConsentActs.toggle).not.toHaveBeenCalled();
      expect(serverConsentActs.review).not.toHaveBeenCalled();
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
        expect.any(Function),
        expect.anything(),
      );
    });

    it("hands the runtime the caller's ceiling, composed as an unscoped Plugin read", async () => {
      const compose = jest.spyOn(scopeComposer, 'compose');
      abilityService.getCurrentResourceConditions.mockReturnValue([{ id: 'p-1' }]);

      await firstValueFrom(controller.list(query()));
      const ceiling = inventory.listForServer.mock.calls[0]?.[1];

      expect(ceiling?.()).toEqual({ AND: [{ id: 'p-1' }] });
      expect(compose).toHaveBeenCalledWith(
        ResourceType.Plugin,
        Action.read,
        SERVER_PLUGIN_LIST_SCOPE,
        SERVER_PLUGIN_COLUMN,
      );
    });

    // The runtime calls the ceiling, and composing it is what the envelope's
    // guard checks for. Built inside a request where nothing calls it, the
    // envelope must fail, naming the type.
    it('builds its envelope under the Plugin scope guard', async () => {
      const envelope = ClsServiceManager.getClsService().runWith({}, () => firstValueFrom(controller.list(query())));

      await expect(envelope).rejects.toThrow(ListScopeNotComposedError);
      await expect(envelope).rejects.toThrow(`intrinsic scope for '${ResourceType.Plugin}'`);
    });

    // The reason is a claim about the catalog, and this is where it is checked:
    // a reach granted later that is neither of these fails here, beside the
    // declaration it would falsify.
    it('stays unscoped only while each reader of Plugin reads every row or holds the fixed filter the gate refuses', () => {
      expect(new Set(shippedReadReaches(ResourceType.Plugin))).toEqual(new Set(['every row', 'fixed filter']));

      const ceilings = deriveReadCeilings(PERMISSION_CATALOG, ROLE_PERMISSION_CATALOG, [
        'all',
        ...Object.values(ResourceType),
      ]);
      const fixedFilters = Object.values(ceilings[ResourceType.Plugin]).flatMap((bySlug) =>
        Object.entries(bySlug)
          .filter(([, reach]) => reach === 'fixed filter')
          .map(([slug]) => slug),
      );
      expect(fixedFilters).toEqual(['read:plugin:installed']);

      const fields = PERMISSION_CATALOG.find(({ slug }) => slug === 'read:plugin:installed')?.fields;
      expect(fields?.length).toBeGreaterThan(0);
      expect(fields).not.toContain('installedAt');
    });

    it('forwards the tombstone opt-in and the CLS locale (D-CH)', async () => {
      auditContext.getLocale.mockReturnValue('de');

      await firstValueFrom(controller.list(query({ includeUninstalled: true })));

      expect(inventory.listForServer).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
        includeUninstalled: true,
        locale: 'de',
      });
    });

    it('an omitted opt-in stays undefined — the service owns the default', async () => {
      await firstValueFrom(controller.list(query()));

      expect(inventory.listForServer).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
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

  // The read gate passes a key's rule whatever plugin its scope names, and the
  // services read by slug alone. So each route resolves its slug under the
  // actor's ceiling first, composed as the server list composes it, and
  // answers a slug outside it with the route's own not-found error: a key
  // cannot tell a plugin outside its scope from one never installed. The
  // routes are the `reads` table at the top of this file.
  describe("the single reads resolve their slug under the actor's ceiling (#789)", () => {
    it.each(reads)(
      'answers $route outside the ceiling with its own not-found error, before its service',
      async ({ call, service, notFound, slugField }) => {
        inventory.existsUnderCeiling.mockResolvedValue(false);

        const refused = firstValueFrom(call());

        await expect(refused).rejects.toBeInstanceOf(notFound);
        await expect(refused).rejects.toMatchObject({ [slugField]: 'demo-sink' });
        expect(service()).not.toHaveBeenCalled();
      },
    );

    it.each(reads)(
      "composes $route's ceiling as the server list does, with the slug as its scope",
      async ({ call }) => {
        const compose = jest.spyOn(scopeComposer, 'compose');
        abilityService.getCurrentResourceConditions.mockReturnValue([{ id: 'p-1' }]);

        await firstValueFrom(call());
        const [slug, ceiling] = inventory.existsUnderCeiling.mock.calls[0] ?? [];

        expect(slug).toBe('demo-sink');
        expect(ceiling?.({ slug: 'demo-sink' })).toEqual({ slug: 'demo-sink', AND: [{ id: 'p-1' }] });
        expect(compose).toHaveBeenCalledWith(
          ResourceType.Plugin,
          Action.read,
          { slug: 'demo-sink' },
          SERVER_PLUGIN_COLUMN,
        );
      },
    );
  });

  // The write gate is type-level too, and the service seam checks only that
  // the acting user is a server admin: it never sees the key. So an Admin's
  // key pinned to one plugin wrote every other until each write resolved its
  // slug under the `manage` ceiling first, as the reads do under `read`. The
  // routes are the `writes` table at the top of this file.
  describe("the writes resolve their slug under the actor's manage ceiling (#978)", () => {
    it.each(writes)(
      'answers $route outside the ceiling with its own not-found error, before its service',
      async ({ call, service, notFound, slugField }) => {
        inventory.existsUnderCeiling.mockResolvedValue(false);

        const refused = firstValueFrom(call());

        await expect(refused).rejects.toBeInstanceOf(notFound);
        await expect(refused).rejects.toMatchObject({ [slugField]: 'demo-sink' });
        expect(service()).not.toHaveBeenCalled();
      },
    );

    // A write serves no column, so its ceiling is built from every `manage`
    // rule, with no column to narrow it by.
    it.each(writes)("composes $route's ceiling under manage, with the slug as its scope", async ({ call }) => {
      const compose = jest.spyOn(scopeComposer, 'compose');
      abilityService.getCurrentResourceConditions.mockReturnValue([{ id: 'p-1' }]);

      await firstValueFrom(call());
      const [slug, ceiling] = inventory.existsUnderCeiling.mock.calls[0] ?? [];

      expect(slug).toBe('demo-sink');
      expect(ceiling?.({ slug: 'demo-sink' })).toEqual({ slug: 'demo-sink', AND: [{ id: 'p-1' }] });
      expect(compose).toHaveBeenCalledWith(ResourceType.Plugin, Action.manage, { slug: 'demo-sink' }, undefined);
    });
  });

  // The controller specs instantiate the class directly, so a dropped
  // @CheckPolicies would change nothing they assert. These read the decorator
  // metadata instead: without them, deleting the read gate from a route that
  // serves installedSha256/installedFromUrl/installedAt would pass the whole
  // suite.
  describe('policy gates', () => {
    const policiesFor = (handler: keyof PluginsController) =>
      Reflect.getMetadata(CHECK_POLICIES_KEY, PluginsController.prototype[handler]) as
        Array<(ability: AppAbility) => boolean> | undefined;

    // A bare `can(read, Plugin)` would pass every user's identity-column grant,
    // so each server read asks about a column that grant leaves out.
    it.each(['list', 'getBySlug', 'featureStates', 'consentPresentation', 'pendingUpdate'] as const)(
      '%s gates on read:Plugin for the server-only installedAt column',
      (handler) => {
        const handlers = policiesFor(handler);
        expect(handlers).toHaveLength(1);

        const can = jest.fn().mockReturnValue(true);
        handlers?.[0]({ can } as unknown as AppAbility);

        expect(can).toHaveBeenCalledWith(Action.read, ResourceType.Plugin, 'installedAt');
      },
    );

    it.each([
      ['toggleConsent', Action.manage],
      ['reviewConsent', Action.manage],
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
      ['consentPresentation', ':slug/consent', RequestMethod.GET],
      ['toggleConsent', ':slug/consent/toggle', RequestMethod.POST],
      ['reviewConsent', ':slug/consent/review', RequestMethod.POST],
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

    it('registers exactly the lifecycle, update-consent, and consent routes', () => {
      const handlers = Object.getOwnPropertyNames(PluginsController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.getMetadata('path', PluginsController.prototype[name as never]) !== undefined,
      );

      expect(handlers).toEqual([
        'list',
        'consentPresentation',
        'toggleConsent',
        'reviewConsent',
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

    // Every `:slug` route must sit in `reads` or `writes`, whose tests pin its
    // assertUnderCeiling call and its unknown-slug error. Listing a new handler
    // in the registration list above is not enough. A route may take an array
    // of paths, so each one is read (#985).
    it('places every :slug route in the reads or writes ceiling table (#985)', () => {
      const slugRoutes = Object.getOwnPropertyNames(PluginsController.prototype)
        .filter((name) => name !== 'constructor')
        .filter((name) => {
          const path: unknown = Reflect.getMetadata('path', PluginsController.prototype[name as never]);
          return [path].flat().some((each) => typeof each === 'string' && each.includes(':slug'));
        })
        .sort();

      expect(slugRoutes).toEqual([...reads, ...writes].map(({ route }) => route).sort());
      expect(slugRoutes).toHaveLength(12);
    });
  });
});
