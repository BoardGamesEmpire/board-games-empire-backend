import type { AuditContextService } from '@bge/actor-context';
import type { HouseholdPlugin, Plugin, PluginGrant, Prisma, UserPlugin } from '@bge/database';
import {
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
} from '@bge/database';
import { deadlock } from '@bge/database/testing';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService, rawQueryText } from '@bge/testing';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { PluginConfigSchemaUnusableError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginDisabledEvent,
  HouseholdPluginEnabledEvent,
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  UserPluginEnabledEvent,
} from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import { PluginUnitAuthorityError, PluginUnitConfigRequiredError } from '../units/unit.errors';
import type { ConsentCheckClassification } from './consent-classification.types';
import {
  PluginConsentActNoUserScopeError,
  PluginConsentActRequiredSetError,
  PluginConsentActStaleError,
  PluginConsentActUnitOffError,
} from './plugin-consent-act.errors';
import type { ConsentActInput, SwitchOnInput } from './plugin-consent-act.service';
import { PluginConsentActService } from './plugin-consent-act.service';
import type { ConsentActAnswer } from './plugin-consent-act.types';
import type { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';

describe('PluginConsentActService', () => {
  const options = buildPluginModuleOptions();

  const REQUIRED = 'plugin|demo-sink|manage:digest';
  const OPTIONAL = 'update:calendar';
  const USER_OPTIONAL = 'read:public_content';
  const STAGED_NEW = 'feedback:read';

  const ACTIVE_SHA = 'sha-active';
  const STAGED_SHA = 'sha-staged';

  const activeChecks: PluginManifest['permissions']['checks'] = [
    {
      slug: 'manage:digest',
      required: true,
      reason: { en: 'Stores and manages the digest configuration it owns.' },
      consentScope: 'household',
    },
    {
      slug: OPTIONAL,
      required: false,
      reason: { en: 'Writes digest reminders to the household calendar.' },
      consentScope: 'household',
    },
    {
      slug: USER_OPTIONAL,
      required: false,
      reason: { en: 'Shows public content excerpts inside per-user digests.' },
      consentScope: 'user',
    },
  ];

  const householdManifest = (config?: Partial<PluginManifest['config']>): PluginManifest =>
    buildPluginManifest({
      scope: 'household',
      permissions: { declares: ['manage:digest'], checks: activeChecks },
      config,
    });

  /** The staged update requests one household permission the active manifest does not. */
  const stagedManifest = (): PluginManifest =>
    buildPluginManifest({
      version: '1.3.0',
      scope: 'household',
      permissions: {
        declares: ['manage:digest'],
        checks: [
          ...activeChecks,
          {
            slug: STAGED_NEW,
            required: false,
            reason: { en: 'Reads submitted feedback for the digest.' },
            consentScope: 'household',
          },
        ],
      },
    });

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Household,
    executionMode: PluginExecutionMode.InProcess,
    enabled: true,
    manifestJson: householdManifest() as unknown as Prisma.JsonValue,
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
    installedSha256: ACTIVE_SHA,
    registrySlug: null,
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    pendingStagingId: null,
    pendingFromUrl: null,
    pendingRegistrySlug: null,
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const stagedPlugin = (overrides: Partial<Plugin> = {}): Plugin =>
    makePlugin({
      pendingVersion: '1.3.0',
      pendingManifestJson: stagedManifest() as unknown as Prisma.JsonValue,
      pendingSha256: STAGED_SHA,
      ...overrides,
    });

  interface ClaimRow {
    readonly installed_sha256: string;
    readonly pending_sha256: string | null;
    readonly pending_staging_id: string | null;
    readonly scope: PluginScope;
    readonly uninstalled_at: Date | null;
  }

  const claimRow = (overrides: Partial<ClaimRow> = {}): ClaimRow => ({
    uninstalled_at: null,
    scope: PluginScope.Household,
    installed_sha256: ACTIVE_SHA,
    pending_sha256: null,
    pending_staging_id: null,
    ...overrides,
  });

  const makeHouseholdRow = (overrides: Partial<HouseholdPlugin> = {}): HouseholdPlugin => ({
    id: 'hp-1',
    householdId: 'hh-1',
    pluginId: 'plugin-1',
    enabled: true,
    config: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makeUserRow = (overrides: Partial<UserPlugin> = {}): UserPlugin => ({
    id: 'up-1',
    userId: 'user-1',
    pluginId: 'plugin-1',
    enabled: true,
    config: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const standingGrant = (
    permissionSlug: string,
    status: PluginGrantStatus,
    overrides: Partial<PluginGrant> = {},
  ): PluginGrant => ({
    id: `grant-${permissionSlug}`,
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Household,
    scopeId: 'hh-1',
    permissionSlug,
    status,
    decidedById: 'admin-1',
    actId: 'act-0',
    decidedAt: new Date(0),
    decidedRiskLevel: RiskLevel.Low,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const granted = (permissionSlug: string): ConsentActAnswer => ({
    permissionSlug,
    status: PluginGrantStatus.Granted,
    riskLevel: RiskLevel.Low,
  });
  const denied = (permissionSlug: string): ConsentActAnswer => ({
    permissionSlug,
    status: PluginGrantStatus.Denied,
    riskLevel: RiskLevel.Low,
  });

  const HOUSEHOLD_UNIT = { scopeType: 'Household', householdId: 'hh-1' } as const;
  const USER_UNIT = { scopeType: 'User', userId: 'user-1' } as const;

  const householdSwitchOn: SwitchOnInput = {
    slug: 'demo-sink',
    unit: HOUSEHOLD_UNIT,
    actorId: 'admin-1',
    manifestSha256: ACTIVE_SHA,
    answers: [granted(REQUIRED), granted(OPTIONAL)],
  };

  const householdToggle: ConsentActInput = {
    slug: 'demo-sink',
    unit: HOUSEHOLD_UNIT,
    actorId: 'admin-1',
    manifestSha256: ACTIVE_SHA,
    answers: [granted(OPTIONAL)],
  };

  const requiredRefusingReview: ConsentActInput = {
    ...householdToggle,
    answers: [denied(REQUIRED)],
  };

  let db: MockDatabaseService;
  let order: string[];
  let claim: ClaimRow;
  let householdRow: HouseholdPlugin | null;
  let userRow: UserPlugin | null;
  let standing: PluginGrant[];
  let classifier: { classify: jest.Mock };
  let authority: jest.Mocked<Pick<PluginGrantAuthorityService, 'householdAdminStanding'>>;
  let emitter: { emit: jest.Mock };
  let service: PluginConsentActService;

  /** Every requested permission pending at Low risk: nothing decided yet, nothing ungrantable. */
  const pendingClassification = (_pluginId: string, _unit: unknown, checks: { canonicalSlug: string }[]) =>
    Promise.resolve<ConsentCheckClassification>({
      decisions: new Map(
        checks.map((check) => [
          check.canonicalSlug,
          { decision: 'pending', decidedRiskLevel: null, staleRisk: false, ungrantable: null },
        ]),
      ),
      currentRiskBySlug: new Map(checks.map((check) => [check.canonicalSlug, RiskLevel.Low])),
    });

  beforeEach(() => {
    order = [];
    claim = claimRow();
    householdRow = null;
    userRow = null;
    standing = [];

    db = createMockDatabaseService();
    db.$transaction.mockImplementation((cb) => cb(db));
    db.plugin.findUnique.mockResolvedValue(makePlugin());

    db.$queryRaw.mockImplementation(((query: unknown) => {
      const sql = rawQueryText(query);

      if (sql.includes('FROM households')) {
        order.push('household lock');
        return Promise.resolve([{ id: 'hh-1' }]);
      }

      if (sql.includes('FROM plugins')) {
        order.push('plugin claim');
        return Promise.resolve([claim]);
      }

      throw new Error(`Unrouted $queryRaw in test: ${sql}`);
    }) as never);

    db.pluginConsentAct.create.mockImplementation((({ data }: { data: Record<string, unknown> }) => {
      order.push('act');
      return Promise.resolve({ id: 'act-1', createdAt: new Date(0), ...data });
    }) as never);
    db.pluginGrant.findMany.mockImplementation((() => {
      order.push('standing read');
      return Promise.resolve(standing);
    }) as never);
    db.pluginGrant.upsert.mockImplementation((({
      create,
    }: {
      create: Omit<PluginGrant, 'id' | 'createdAt' | 'updatedAt'>;
    }) => {
      order.push(`grant:${create.permissionSlug}`);
      return Promise.resolve({
        ...create,
        id: `grant-${create.permissionSlug}`,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
    }) as never);

    db.householdPlugin.findUnique.mockImplementation((() => {
      order.push('unit read');
      return Promise.resolve(householdRow);
    }) as never);
    db.householdPlugin.update.mockImplementation((({ data }: { data: Partial<HouseholdPlugin> }) => {
      order.push('unit');
      // Prisma leaves a column whose value is `undefined` as it is.
      const written = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
      return Promise.resolve({ ...(householdRow as HouseholdPlugin), ...written });
    }) as never);
    db.householdPlugin.upsert.mockImplementation((({
      create,
      update,
    }: {
      create: Partial<HouseholdPlugin>;
      update: Partial<HouseholdPlugin>;
    }) => {
      order.push('unit');

      if (householdRow === null) {
        return Promise.resolve(makeHouseholdRow(create));
      }

      // Prisma leaves a column whose value is `undefined` as it is.
      const written = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
      return Promise.resolve({ ...householdRow, ...written });
    }) as never);
    db.userPlugin.findUnique.mockImplementation((() => {
      order.push('unit read');
      return Promise.resolve(userRow);
    }) as never);
    db.userPlugin.upsert.mockImplementation((({ create }: { create: Partial<UserPlugin> }) => {
      order.push('unit');
      return Promise.resolve(userRow === null ? makeUserRow(create) : { ...userRow, enabled: true });
    }) as never);
    db.userPlugin.update.mockImplementation((({ data }: { data: Partial<UserPlugin> }) => {
      order.push('unit');
      return Promise.resolve({ ...(userRow as UserPlugin), ...data });
    }) as never);

    classifier = { classify: jest.fn(pendingClassification) };
    authority = { householdAdminStanding: jest.fn().mockResolvedValue('admin') };
    emitter = { emit: jest.fn() };

    service = new PluginConsentActService(
      db as never,
      classifier as unknown as PluginConsentCheckClassifier,
      authority as unknown as PluginGrantAuthorityService,
      new PluginConfigSchemaService(),
      { getCorrelationId: () => 'corr-1' } as unknown as AuditContextService,
      emitter as never,
      options,
    );
  });

  const emitted = () => emitter.emit.mock.calls.map(([name, event]) => ({ name, event }));

  /** Nothing reached the tables a consent act writes. */
  const expectNothingWritten = () => {
    expect(db.pluginConsentAct.create).not.toHaveBeenCalled();
    expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    expect(db.householdPlugin.update).not.toHaveBeenCalled();
    expect(db.householdPlugin.upsert).not.toHaveBeenCalled();
    expect(db.userPlugin.upsert).not.toHaveBeenCalled();
    expect(db.userPlugin.update).not.toHaveBeenCalled();
  };

  describe('switchOn', () => {
    it('a household switch-on claims the plugin row, reads the unit, then writes one act, the decisions in permission order and the unit enablement (#1150, #1152)', async () => {
      const result = await service.switchOn(householdSwitchOn);

      // The household row and the plugin row are the only locks taken before
      // the writes: nothing orders two acts on one unit (#1152).
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(order).toEqual([
        'household lock',
        'plugin claim',
        'unit read',
        'standing read',
        'act',
        `grant:${REQUIRED}`,
        `grant:${OPTIONAL}`,
        'unit',
      ]);

      const [[{ data: act }]] = db.pluginConsentAct.create.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(act).toEqual(
        expect.objectContaining({
          pluginId: 'plugin-1',
          pluginSlug: 'demo-sink',
          scopeType: PluginGrantScope.Household,
          scopeId: 'hh-1',
          kind: 'SwitchOn',
          manifestVersion: '1.2.0',
          manifestSha256: ACTIVE_SHA,
          // An act on the active manifest answered no staging (#1152).
          stagingId: null,
          decidedById: 'admin-1',
          correlationId: 'corr-1',
        }),
      );
      expect(act['presentation']).toEqual({
        locale: 'en',
        source: 'active',
        checks: [
          expect.objectContaining({ slug: REQUIRED, required: true, outcome: 'granted' }),
          expect.objectContaining({ slug: OPTIONAL, required: false, outcome: 'granted' }),
        ],
      });

      const upserts = db.pluginGrant.upsert.mock.calls.map(([args]) => args) as unknown as {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }[];
      expect(upserts).toHaveLength(2);
      for (const upsert of upserts) {
        expect(upsert.create).toEqual(
          expect.objectContaining({ actId: 'act-1', decidedById: 'admin-1', status: PluginGrantStatus.Granted }),
        );
        expect(upsert.update).toEqual(expect.objectContaining({ actId: 'act-1', decidedById: 'admin-1' }));
        expect(upsert.create['decidedAt']).toBe(act['decidedAt']);
      }

      expect(db.householdPlugin.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: { householdId: 'hh-1', pluginId: 'plugin-1', enabled: true, config: {} },
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ changed: true, switchedOff: false, act: expect.objectContaining({ id: 'act-1' }) }),
      );
    });

    it('a household switch-on writes the unit enablement by upsert, so a racing first switch-on updates rather than collides (#1152)', async () => {
      // No unit enablement; a document supplied.
      await service.switchOn({ ...householdSwitchOn, config: { webhookUrl: 'https://example.test/hook' } });

      expect(db.householdPlugin.upsert).toHaveBeenCalledWith({
        where: { householdId_pluginId: { householdId: 'hh-1', pluginId: 'plugin-1' } },
        create: {
          householdId: 'hh-1',
          pluginId: 'plugin-1',
          enabled: true,
          config: { webhookUrl: 'https://example.test/hook' },
        },
        update: { enabled: true, config: { webhookUrl: 'https://example.test/hook' } },
      });
      expect(db.householdPlugin.create).not.toHaveBeenCalled();
    });

    it('a household switch-on with no document creates the unit enablement holding {} and leaves a retained document as it is (#1152)', async () => {
      await service.switchOn(householdSwitchOn);

      const [[upsert]] = db.householdPlugin.upsert.mock.calls as unknown as [
        [{ create: Record<string, unknown>; update: Record<string, unknown> }],
      ];
      expect(upsert.create).toEqual({ householdId: 'hh-1', pluginId: 'plugin-1', enabled: true, config: {} });
      // `undefined` writes no column, so the update arm keeps a document a
      // racing switch-on's insert left.
      expect(upsert.update).toEqual({ enabled: true, config: undefined });
      expect(upsert.update['config']).toBeUndefined();
    });

    it("classifies the unit's decisions only under the plugin-row claim, so the plan judges the manifest the claim pinned (#1150, #1152)", async () => {
      // Classified before the claim, the plan could judge a manifest an
      // activation has since replaced, which the claim's sha comparison exists
      // to refuse.
      classifier.classify.mockImplementation((...args: Parameters<typeof pendingClassification>) => {
        order.push('classify');
        return pendingClassification(...args);
      });

      await service.switchOn(householdSwitchOn);

      expect(order.slice(0, 3)).toEqual(['household lock', 'plugin claim', 'classify']);
    });

    it('a switch-on naming a sha the plugin has moved off is refused before anything is written (#1150)', async () => {
      await expect(service.switchOn({ ...householdSwitchOn, manifestSha256: 'sha-elsewhere' })).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }),
      );
      expect(db.$transaction).not.toHaveBeenCalled();
      expectNothingWritten();

      // The claim, under the plugin row's share lock, sees an activation that
      // committed after the pre-transaction read.
      claim = claimRow({ installed_sha256: 'sha-newer' });

      await expect(service.switchOn(householdSwitchOn)).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }),
      );
      expect(order).toEqual(['household lock', 'plugin claim']);
      expectNothingWritten();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("a user's switch-on creates their unit enablement (#1150)", async () => {
      const result = await service.switchOn({
        slug: 'demo-sink',
        unit: USER_UNIT,
        actorId: 'user-1',
        manifestSha256: ACTIVE_SHA,
        answers: [granted(USER_OPTIONAL)],
      });

      expect(order).toEqual(['plugin claim', 'unit read', 'standing read', 'act', `grant:${USER_OPTIONAL}`, 'unit']);
      expect(db.userPlugin.upsert).toHaveBeenCalledWith({
        where: { userId_pluginId: { userId: 'user-1', pluginId: 'plugin-1' } },
        create: { userId: 'user-1', pluginId: 'plugin-1', enabled: true },
        update: { enabled: true },
      });
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ scopeType: PluginGrantScope.User, scopeId: 'user-1', actId: 'act-1' }),
        }),
      );
      expect(result.unit).toEqual(expect.objectContaining({ userId: 'user-1', enabled: true }));

      const enabled = emitted().filter(({ event }) => event instanceof UserPluginEnabledEvent);
      expect(enabled).toHaveLength(1);
      expect(enabled[0].event.before).toBeNull();
    });

    it('a user switch-on of a plugin that requests nothing at user scope is refused before any lock (#381, #1150)', async () => {
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({
          manifestJson: buildPluginManifest({
            scope: 'household',
            permissions: {
              declares: ['manage:digest'],
              checks: activeChecks.filter((check) => check.consentScope !== 'user'),
            },
          }) as unknown as Prisma.JsonValue,
        }),
      );

      await expect(
        service.switchOn({
          slug: 'demo-sink',
          unit: USER_UNIT,
          actorId: 'user-1',
          manifestSha256: ACTIVE_SHA,
          answers: [],
        }),
      ).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActNoUserScopeError, pluginSlug: 'demo-sink' }),
      );
      expect(db.$transaction).not.toHaveBeenCalled();
      expectNothingWritten();

      // A household switch-on of the same plugin is unaffected: it requests
      // something at household scope.
      await expect(service.switchOn(householdSwitchOn)).resolves.toEqual(expect.objectContaining({ changed: true }));
    });

    it('a user cannot switch a plugin on for someone else (#1150)', async () => {
      await expect(
        service.switchOn({
          slug: 'demo-sink',
          unit: USER_UNIT,
          actorId: 'user-2',
          manifestSha256: ACTIVE_SHA,
          answers: [granted(USER_OPTIONAL)],
        }),
      ).rejects.toBeInstanceOf(PluginUnitAuthorityError);
      expect(db.$transaction).not.toHaveBeenCalled();
      expectNothingWritten();
    });

    it('a switch-on sent again after it succeeded changes nothing: no act, no decision write, no event (#1150)', async () => {
      householdRow = makeHouseholdRow();
      standing = [
        standingGrant(REQUIRED, PluginGrantStatus.Granted),
        standingGrant(OPTIONAL, PluginGrantStatus.Granted),
      ];

      const result = await service.switchOn(householdSwitchOn);

      expect(result).toEqual({ act: null, changed: false, unit: householdRow, switchedOff: false });
      expectNothingWritten();
      expect(order).toEqual(['household lock', 'plugin claim', 'unit read', 'standing read']);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a switch-on over a switched-off unit with every decision already standing still writes an act and switches it on (#1150)', async () => {
      householdRow = makeHouseholdRow({ enabled: false });
      standing = [
        standingGrant(REQUIRED, PluginGrantStatus.Granted),
        standingGrant(OPTIONAL, PluginGrantStatus.Granted),
      ];

      const result = await service.switchOn(householdSwitchOn);

      expect(db.pluginConsentAct.create).toHaveBeenCalledTimes(1);
      // Every planned decision is written with the act, so its actId names the
      // act that last set it, but only a changed row is announced.
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(2);
      expect(db.householdPlugin.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { enabled: true, config: undefined } }),
      );
      expect(result.changed).toBe(true);
      expect(result.unit).toEqual(expect.objectContaining({ enabled: true }));
      // No consent decision changed, so the switch event is what names the
      // act in the lifecycle table.
      expect(emitted().map(({ event }) => event.constructor)).toEqual([HouseholdPluginEnabledEvent]);
      expect(emitted()[0].event.act).toEqual({ manifestVersion: '1.2.0', actId: 'act-1' });
    });

    it('a household switch-on without config is refused when the manifest requires one and none is retained (#1150)', async () => {
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({
          manifestJson: householdManifest({ requiresHouseholdConfig: true }) as unknown as Prisma.JsonValue,
        }),
      );

      await expect(service.switchOn(householdSwitchOn)).rejects.toBeInstanceOf(PluginUnitConfigRequiredError);
      expectNothingWritten();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a household switch-on over a unit already in service changes the decisions, not the unit enablement (#1150)', async () => {
      householdRow = makeHouseholdRow();

      const result = await service.switchOn(householdSwitchOn);

      expect(db.pluginConsentAct.create).toHaveBeenCalledTimes(1);
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(2);
      // A unit already switched on, with no document supplied, needs no
      // write: the document it holds passed the config gate (#323, #1151).
      expect(db.householdPlugin.upsert).not.toHaveBeenCalled();
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ changed: true, switchedOff: false, unit: householdRow }));
      expect(emitted().map(({ event }) => event.constructor)).toEqual([
        PluginGrantCreatedEvent,
        PluginGrantCreatedEvent,
      ]);
    });

    /**
     * A household unit's dormancy is worked out when read from the document
     * its unit enablement holds, so a switch-on that supplies no document is
     * judged on the one it would leave the unit holding, whether or not the
     * manifest requires configuration (#1151).
     */
    describe('the document a household unit would hold (#1151)', () => {
      /** A schema `{}` and `{ webhookUrl: 42 }` both fail; the manifest does not require configuration. */
      const schemaRequiringWebhook = () =>
        makePlugin({
          manifestJson: householdManifest({
            schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
            requiresHouseholdConfig: false,
          }) as unknown as Prisma.JsonValue,
        });

      beforeEach(() => {
        db.plugin.findUnique.mockResolvedValue(schemaRequiringWebhook());
        standing = [
          standingGrant(REQUIRED, PluginGrantStatus.Granted),
          standingGrant(OPTIONAL, PluginGrantStatus.Granted),
        ];
      });

      it('refuses a switch-on sent again for a unit already on whose retained document no longer conforms (#1151)', async () => {
        householdRow = makeHouseholdRow({ enabled: true, config: { webhookUrl: 42 } });

        await expect(service.switchOn(householdSwitchOn)).rejects.toEqual(
          expect.objectContaining({
            constructor: PluginUnitConfigRequiredError,
            issues: [expect.objectContaining({ keyword: 'type' })],
          }),
        );
        // Refused before the act: the document is judged as soon as the unit
        // enablement is read, so no act, decision or unit write is made.
        expectNothingWritten();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('refuses a first switch-on when {} fails the schema, though the manifest does not require configuration (#1151)', async () => {
        standing = [];

        await expect(service.switchOn(householdSwitchOn)).rejects.toEqual(
          expect.objectContaining({
            constructor: PluginUnitConfigRequiredError,
            issues: [expect.objectContaining({ keyword: 'required' })],
          }),
        );
        expectNothingWritten();
      });

      it('refuses a switch-on with no document under a schema that cannot be used before any lock is taken (#1151)', async () => {
        // The read calls such a unit `unavailable`, and no configuration
        // cures it, so the act refuses it before the transaction opens.
        db.plugin.findUnique.mockResolvedValue(
          makePlugin({
            manifestJson: householdManifest({ schema: { type: 'no-such-type' } }) as unknown as Prisma.JsonValue,
          }),
        );
        householdRow = makeHouseholdRow({ enabled: true, config: { webhookUrl: 'https://retained.test' } });

        await expect(service.switchOn(householdSwitchOn)).rejects.toBeInstanceOf(PluginConfigSchemaUnusableError);
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(order).toEqual([]);
        expectNothingWritten();
      });

      it('answers changed: false for a switch-on sent again when the retained document conforms (#1151)', async () => {
        householdRow = makeHouseholdRow({ enabled: true, config: { webhookUrl: 'https://retained.test' } });

        const result = await service.switchOn(householdSwitchOn);

        expect(result).toEqual({ act: null, changed: false, unit: householdRow, switchedOff: false });
        expectNothingWritten();
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('switches on with a supplied document and writes only the switch and the document (#1151)', async () => {
        householdRow = makeHouseholdRow({ enabled: false, config: { webhookUrl: 42 } });

        const result = await service.switchOn({ ...householdSwitchOn, config: { webhookUrl: 'https://new.test' } });

        const [[{ update }]] = db.householdPlugin.upsert.mock.calls as unknown as [
          [{ update: Record<string, unknown> }],
        ];
        expect(Object.keys(update).sort()).toEqual(['config', 'enabled']);
        expect(update).toEqual({ enabled: true, config: { webhookUrl: 'https://new.test' } });
        expect(result.unit).toEqual(
          expect.objectContaining({ enabled: true, config: { webhookUrl: 'https://new.test' } }),
        );
      });

      it('emits no dormancy event: a supplied document over one the schema rejects announces the configuration and nothing else (#1151)', async () => {
        // The held document reads as needs_configuration. Dormancy is worked
        // out when read, so the act announces only what it wrote.
        householdRow = makeHouseholdRow({ enabled: true, config: { webhookUrl: 42 } });

        const result = await service.switchOn({ ...householdSwitchOn, config: { webhookUrl: 'https://new.test' } });

        expect(result.changed).toBe(true);
        expect(db.householdPlugin.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ update: { enabled: true, config: { webhookUrl: 'https://new.test' } } }),
        );
        // The decisions stood and the switch was already on, so the
        // configuration event is the one that names the act.
        expect(emitted().map(({ event }) => event.constructor)).toEqual([HouseholdPluginConfigUpdatedEvent]);
        expect(emitted()[0].event.act).toEqual({ manifestVersion: '1.2.0', actId: 'act-1' });
      });
    });

    it('a household switch-on with config writes it with the unit enablement and announces it (#1150)', async () => {
      await service.switchOn({ ...householdSwitchOn, config: { webhookUrl: 'https://example.com' } });

      expect(db.householdPlugin.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            householdId: 'hh-1',
            pluginId: 'plugin-1',
            enabled: true,
            config: { webhookUrl: 'https://example.com' },
          },
        }),
      );
      const config = emitted().find(({ event }) => event instanceof HouseholdPluginConfigUpdatedEvent);
      expect(config?.event.before).toEqual({ id: 'hp-1', householdId: 'hh-1', pluginId: 'plugin-1', config: {} });
    });
  });

  describe('toggle', () => {
    it('a toggle on a switched-off unit is refused (#1150)', async () => {
      householdRow = makeHouseholdRow({ enabled: false });

      await expect(service.toggle(householdToggle)).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActUnitOffError, scopeType: 'Household' }),
      );
      expectNothingWritten();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a toggle on a unit with no unit enablement is refused (#1150)', async () => {
      await expect(service.toggle(householdToggle)).rejects.toBeInstanceOf(PluginConsentActUnitOffError);
      expectNothingWritten();
    });

    it('a toggle reads the switch inside its transaction, so a switch-off committed first refuses it before anything is written (#1150)', async () => {
      householdRow = makeHouseholdRow({ enabled: false });

      await expect(service.toggle(householdToggle)).rejects.toBeInstanceOf(PluginConsentActUnitOffError);
      expect(order).toEqual(['household lock', 'plugin claim', 'unit read', 'standing read']);
      expectNothingWritten();
    });

    it('lets a toggle through for a switched-on unit whose configuration no longer conforms (#1150, #1151)', async () => {
      // A toggle needs the unit's switch on, not a unit that serves: the
      // household can settle its consent decisions before it fixes the
      // configuration.
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({
          manifestJson: householdManifest({
            schema: { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] },
          }) as unknown as Prisma.JsonValue,
        }),
      );
      householdRow = makeHouseholdRow({ config: { webhookUrl: 42 } });

      const result = await service.toggle(householdToggle);

      expect(order).toEqual([
        'household lock',
        'plugin claim',
        'unit read',
        'standing read',
        'act',
        `grant:${OPTIONAL}`,
      ]);
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ changed: true, switchedOff: false, unit: householdRow }));
      expect(emitted().map(({ name }) => name)).toEqual([PluginGrantCreatedEvent.eventName]);
    });
  });

  describe('review', () => {
    it('a review that refuses a required permission writes the denial and switches the unit off in one transaction, and says so (#1150)', async () => {
      householdRow = makeHouseholdRow();

      const result = await service.review(requiredRefusingReview);

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(order).toEqual([
        'household lock',
        'plugin claim',
        'unit read',
        'standing read',
        'act',
        `grant:${REQUIRED}`,
        'unit',
      ]);
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ status: PluginGrantStatus.Denied }) }),
      );
      expect(db.householdPlugin.update).toHaveBeenCalledWith({ where: { id: 'hp-1' }, data: { enabled: false } });
      expect(result).toEqual(expect.objectContaining({ changed: true, switchedOff: true }));
      expect(result.unit.enabled).toBe(false);
      expect(emitted().map(({ event }) => event.constructor)).toEqual([
        PluginGrantRejectedEvent,
        HouseholdPluginDisabledEvent,
      ]);
      expect(emitted()[1].event.act).toEqual({ manifestVersion: '1.2.0', actId: 'act-1' });
    });

    it('a review sent again after it switched the unit off changes nothing, and still says the unit is switched off (#1150)', async () => {
      // The retry answers as its first attempt did, so a client that lost
      // the first response tells the household the same thing.
      householdRow = makeHouseholdRow({ enabled: false });
      standing = [standingGrant(REQUIRED, PluginGrantStatus.Denied)];

      const result = await service.review(requiredRefusingReview);

      expect(result).toEqual({ act: null, changed: false, unit: householdRow, switchedOff: true });
      expectNothingWritten();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a review that refuses a required permission whose denial already stands still switches the unit off and records the act (#1150)', async () => {
      // Refused while optional, since promoted to required by an update: the
      // row already holds the denial, but the unit is still switched on.
      householdRow = makeHouseholdRow();
      standing = [standingGrant(REQUIRED, PluginGrantStatus.Denied)];

      const result = await service.review(requiredRefusingReview);

      expect(db.pluginConsentAct.create).toHaveBeenCalledTimes(1);
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ actId: 'act-1' }) }),
      );
      expect(db.householdPlugin.update).toHaveBeenCalledWith({ where: { id: 'hp-1' }, data: { enabled: false } });
      expect(result).toEqual(expect.objectContaining({ changed: true, switchedOff: true }));
      // The row's status and risk did not change, so no consent decision event.
      expect(emitted().map(({ event }) => event.constructor)).toEqual([HouseholdPluginDisabledEvent]);
    });

    it('a review that switches the unit off is refused when the unit is off and the denial does not stand yet (#1150)', async () => {
      householdRow = makeHouseholdRow({ enabled: false });

      await expect(service.review(requiredRefusingReview)).rejects.toBeInstanceOf(PluginConsentActUnitOffError);
      expectNothingWritten();
    });

    it('a staged review reads the staged manifest and records the staged version, sha and staging on the act (#1150, #1152)', async () => {
      db.plugin.findUnique.mockResolvedValue(stagedPlugin());
      claim = claimRow({ pending_sha256: STAGED_SHA, pending_staging_id: 'staging-a' });
      householdRow = makeHouseholdRow();

      const result = await service.review({
        ...householdToggle,
        manifestSha256: STAGED_SHA,
        answers: [granted(STAGED_NEW)],
      });

      expect(classifier.classify).toHaveBeenCalledWith(
        'plugin-1',
        HOUSEHOLD_UNIT,
        expect.arrayContaining([expect.objectContaining({ canonicalSlug: STAGED_NEW })]),
        { source: 'staged', client: db },
      );
      expect(db.pluginConsentAct.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'Review',
          manifestVersion: '1.3.0',
          manifestSha256: STAGED_SHA,
          // The staging the claim read under the share lock: the one a
          // rejection deletes this act's decisions by.
          stagingId: 'staging-a',
          presentation: expect.objectContaining({ source: 'staged' }),
        }),
      });
      expect(result.changed).toBe(true);

      const [created] = emitted();
      expect(created.event).toBeInstanceOf(PluginGrantCreatedEvent);
      expect(created.event.context).toEqual({ manifestVersion: '1.3.0', actId: 'act-1' });
    });

    it('a staged review writes only the decisions it changes, so a decision that already stands keeps the act that gave it (#1152)', async () => {
      // The staged update requests two household permissions the active
      // manifest does not: one the unit decided under an earlier manifest,
      // whose decision activation kept, and one it never decided. Rejecting
      // the staging deletes the decisions whose act names it, so re-stamping
      // the kept one would take a decision the unit gave before the staging.
      const KEPT = 'read:game:public';
      const stagedWithKept = buildPluginManifest({
        version: '1.3.0',
        scope: 'household',
        permissions: {
          declares: ['manage:digest'],
          checks: [
            ...activeChecks,
            { slug: KEPT, required: false, reason: { en: 'Lists public games.' }, consentScope: 'household' },
            {
              slug: STAGED_NEW,
              required: false,
              reason: { en: 'Reads submitted feedback for the digest.' },
              consentScope: 'household',
            },
          ],
        },
      });
      db.plugin.findUnique.mockResolvedValue(
        stagedPlugin({ pendingManifestJson: stagedWithKept as unknown as Prisma.JsonValue }),
      );
      claim = claimRow({ pending_sha256: STAGED_SHA, pending_staging_id: 'staging-a' });
      householdRow = makeHouseholdRow();
      standing = [standingGrant(KEPT, PluginGrantStatus.Granted, { actId: 'act-earlier' })];

      const result = await service.review({
        ...householdToggle,
        manifestSha256: STAGED_SHA,
        answers: [granted(KEPT), granted(STAGED_NEW)],
      });

      expect(result.changed).toBe(true);
      expect(order.filter((step) => step.startsWith('grant:'))).toEqual([`grant:${STAGED_NEW}`]);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ permissionSlug: KEPT }) }),
      );
      // The act still records everything the review was shown and answered.
      expect(db.pluginConsentAct.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          stagingId: 'staging-a',
          presentation: expect.objectContaining({
            checks: expect.arrayContaining([
              expect.objectContaining({ slug: KEPT, outcome: 'granted' }),
              expect.objectContaining({ slug: STAGED_NEW, outcome: 'granted' }),
            ]),
          }),
        }),
      });
    });

    it('a staged review that changes a kept decision writes it under the staged act, so it goes with the staging if that is rejected (#1152)', async () => {
      // The staged update requests again a permission the unit refused under
      // an earlier manifest, and activation kept that refusal. Granting it
      // changes the decision, so it is written, and its row names this act,
      // which names the staging: nothing records the earlier refusal to put
      // back, so a rejection of the staging deletes it as a pre-consent.
      const KEPT = 'read:game:public';
      const stagedWithKept = buildPluginManifest({
        version: '1.3.0',
        scope: 'household',
        permissions: {
          declares: ['manage:digest'],
          checks: [
            ...activeChecks,
            { slug: KEPT, required: false, reason: { en: 'Lists public games.' }, consentScope: 'household' },
          ],
        },
      });
      db.plugin.findUnique.mockResolvedValue(
        stagedPlugin({ pendingManifestJson: stagedWithKept as unknown as Prisma.JsonValue }),
      );
      claim = claimRow({ pending_sha256: STAGED_SHA, pending_staging_id: 'staging-a' });
      householdRow = makeHouseholdRow();
      standing = [standingGrant(KEPT, PluginGrantStatus.Denied, { actId: 'act-earlier' })];

      const result = await service.review({
        ...householdToggle,
        manifestSha256: STAGED_SHA,
        answers: [granted(KEPT)],
      });

      expect(result.changed).toBe(true);
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ permissionSlug: KEPT, status: PluginGrantStatus.Granted, actId: 'act-1' }),
          update: expect.objectContaining({ status: PluginGrantStatus.Granted, actId: 'act-1' }),
        }),
      );
      expect(db.pluginConsentAct.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'Review', manifestSha256: STAGED_SHA, stagingId: 'staging-a' }),
      });
    });

    it('a review naming a staged sha that is no longer staged is refused as stale (#1150)', async () => {
      householdRow = makeHouseholdRow();
      const stagedReview = { ...householdToggle, manifestSha256: STAGED_SHA, answers: [granted(STAGED_NEW)] };

      // Nothing staged any more: the update was approved or discarded.
      db.plugin.findUnique.mockResolvedValue(stagedPlugin({ pendingSha256: null }));
      await expect(service.review(stagedReview)).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }),
      );

      // A different update is staged now.
      db.plugin.findUnique.mockResolvedValue(stagedPlugin({ pendingSha256: 'sha-another' }));
      await expect(service.review(stagedReview)).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }),
      );
      expect(db.$transaction).not.toHaveBeenCalled();

      // Staged when read, replaced before the claim.
      db.plugin.findUnique.mockResolvedValue(stagedPlugin());
      claim = claimRow({ pending_sha256: 'sha-another' });
      await expect(service.review(stagedReview)).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }),
      );
      expectNothingWritten();
    });

    it('a staged review is refused as stale when the active manifest moved under it (#1150)', async () => {
      // The staged-not-new rule judged the answers against the active manifest
      // read before the transaction, so the claim must still find that one.
      db.plugin.findUnique.mockResolvedValue(stagedPlugin());
      claim = claimRow({ installed_sha256: 'sha-reinstalled', pending_sha256: STAGED_SHA });
      householdRow = makeHouseholdRow();

      await expect(
        service.review({ ...householdToggle, manifestSha256: STAGED_SHA, answers: [granted(STAGED_NEW)] }),
      ).rejects.toEqual(expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }));
      expectNothingWritten();
    });

    it('a staged review is refused as stale when the claim reads a staged sha with no staging id, rather than record an act that names no staging (#1152)', async () => {
      // The database keeps the staged columns all set or all null, so this
      // row cannot be reached. Recorded, the review would name no staging,
      // and rejecting the update could never find its pre-consents.
      db.plugin.findUnique.mockResolvedValue(stagedPlugin());
      claim = claimRow({ pending_sha256: STAGED_SHA, pending_staging_id: null });
      householdRow = makeHouseholdRow();

      await expect(
        service.review({ ...householdToggle, manifestSha256: STAGED_SHA, answers: [granted(STAGED_NEW)] }),
      ).rejects.toEqual(expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }));
      expectNothingWritten();
    });
  });

  describe('events', () => {
    it('events carry the act id and are emitted only after the transaction resolves (#1150)', async () => {
      db.$transaction.mockImplementation(async (cb) => {
        const result = await cb(db);
        order.push('commit');
        return result;
      });
      emitter.emit.mockImplementation((name: string) => {
        order.push(`emit:${name}`);
        return true;
      });

      await service.switchOn(householdSwitchOn);

      expect(order.slice(order.indexOf('commit'))).toEqual([
        'commit',
        `emit:${PluginGrantCreatedEvent.eventName}`,
        `emit:${PluginGrantCreatedEvent.eventName}`,
        `emit:${HouseholdPluginEnabledEvent.eventName}`,
      ]);

      const grants = emitted()
        .map(({ event }) => event)
        .filter((event) => event instanceof PluginGrantCreatedEvent);
      expect(grants.map((event) => event.context)).toEqual([
        { manifestVersion: '1.2.0', actId: 'act-1' },
        { manifestVersion: '1.2.0', actId: 'act-1' },
      ]);
      expect(grants.map((event) => event.after.permissionSlug)).toEqual([REQUIRED, OPTIONAL]);
      expect(grants.every((event) => event.before === null)).toBe(true);

      // The unit's own event names the act too (#1150).
      const switchedOn = emitted().find(({ event }) => event instanceof HouseholdPluginEnabledEvent);
      expect(switchedOn?.event.act).toEqual({ manifestVersion: '1.2.0', actId: 'act-1' });
    });

    it('a household switch-on with config names the act on its config event (#1150)', async () => {
      await service.switchOn({ ...householdSwitchOn, config: { webhookUrl: 'https://example.com' } });

      const config = emitted().find(({ event }) => event instanceof HouseholdPluginConfigUpdatedEvent);
      expect(config?.event.act).toEqual({ manifestVersion: '1.2.0', actId: 'act-1' });
    });

    it('a refused act emits nothing (#1150)', async () => {
      await expect(service.switchOn({ ...householdSwitchOn, answers: [granted(OPTIONAL)] })).rejects.toBeInstanceOf(
        PluginConsentActRequiredSetError,
      );
      expectNothingWritten();
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('deadlock', () => {
    it('does not replay the transaction when Postgres picks it as a deadlock victim (#1152)', async () => {
      // The API answers the deadlock as a retryable 409, and the client sends
      // the act again: an aborted act reaches the caller as it is.
      const victim = deadlock();
      db.$transaction.mockImplementationOnce(() => Promise.reject(victim));

      await expect(service.switchOn(householdSwitchOn)).rejects.toBe(victim);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });
});
