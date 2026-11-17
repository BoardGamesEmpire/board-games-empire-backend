import { SERVER_PLUGIN_UNIT, type AuditContextService } from '@bge/actor-context';
import {
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
  type Plugin,
  type PluginGrant,
  type Prisma,
} from '@bge/database';
import { deadlock } from '@bge/database/testing';
import { createMockDatabaseService, rawQueryText, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { PluginGrantCreatedEvent, PluginGrantRejectedEvent } from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { PluginLifecycleAuthorityError } from '../lifecycle/lifecycle.errors';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import { PluginUnitPluginNotFoundError, PluginUnitPluginTombstonedError } from '../units/unit.errors';
import type { ConsentCheckClassification } from './consent-classification.types';
import { PluginConsentActAnswerError, PluginConsentActStaleError } from './plugin-consent-act.errors';
import type { ConsentActAnswer } from './plugin-consent-act.types';
import type { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';
import { PluginServerConsentActService, type ServerConsentActInput } from './plugin-server-consent-act.service';

describe('PluginServerConsentActService', () => {
  const options = buildPluginModuleOptions();

  const REQUIRED = 'plugin|demo-sink|manage:digest';
  const OPTIONAL = 'feedback:read';
  const SECOND_OPTIONAL = 'read:public_content';
  const HOUSEHOLD_OPTIONAL = 'update:calendar';

  const SHA = 'sha-active';
  const STAGED_SHA = 'sha-staged';

  /** A required and two optional server-scope requests, and one a household decides. */
  const checks: PluginManifest['permissions']['checks'] = [
    {
      slug: 'manage:digest',
      required: true,
      reason: { en: 'Stores and manages the digest configuration it owns.' },
      consentScope: 'server',
    },
    {
      slug: OPTIONAL,
      required: false,
      reason: { en: 'Reads submitted feedback to compose the weekly digest.' },
      consentScope: 'server',
    },
    {
      slug: SECOND_OPTIONAL,
      required: false,
      reason: { en: 'Shows public content excerpts inside the digest.' },
      consentScope: 'server',
    },
    {
      slug: HOUSEHOLD_OPTIONAL,
      required: false,
      reason: { en: 'Writes digest reminders to the household calendar.' },
      consentScope: 'household',
    },
  ];

  /** A household-scope plugin, so it may request permissions a household decides beside the server's. */
  const manifest = buildPluginManifest({ scope: 'household', permissions: { declares: ['manage:digest'], checks } });

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Household,
    executionMode: PluginExecutionMode.InProcess,
    enabled: true,
    manifestJson: manifest as unknown as Prisma.JsonValue,
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
    installedSha256: SHA,
    registrySlug: null,
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    pendingStagingId: null,
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  interface ClaimRow {
    readonly uninstalled_at: Date | null;
    readonly installed_sha256: string;
  }

  const serverRow = (permissionSlug: string, status: PluginGrantStatus, decidedRiskLevel: RiskLevel): PluginGrant => ({
    id: `grant-${permissionSlug}`,
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Server,
    scopeId: SERVER_SCOPE_SENTINEL,
    permissionSlug,
    status,
    decidedById: 'admin-0',
    actId: 'act-0',
    decidedAt: new Date(0),
    decidedRiskLevel,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  const granted = (permissionSlug: string, riskLevel: RiskLevel = RiskLevel.Low): ConsentActAnswer => ({
    permissionSlug,
    status: PluginGrantStatus.Granted,
    riskLevel,
  });
  const denied = (permissionSlug: string, riskLevel: RiskLevel = RiskLevel.Low): ConsentActAnswer => ({
    permissionSlug,
    status: PluginGrantStatus.Denied,
    riskLevel,
  });

  const input = (overrides: Partial<ServerConsentActInput> = {}): ServerConsentActInput => ({
    slug: 'demo-sink',
    actorId: 'admin-1',
    manifestSha256: SHA,
    answers: [granted(OPTIONAL)],
    ...overrides,
  });

  let db: MockDatabaseService;
  let order: string[];
  let claim: ClaimRow | undefined;
  let standing: PluginGrant[];
  let catalogRisk: Map<string, RiskLevel>;
  let classifier: { classify: jest.Mock };
  let authority: { isServerAdmin: jest.Mock };
  let emitter: { emit: jest.Mock };
  let service: PluginServerConsentActService;

  const arrangePlugin = (overrides: Partial<Plugin> = {}) => {
    db.plugin.findUnique.mockResolvedValue(makePlugin(overrides));
  };

  const arrangeClaim = (overrides: Partial<ClaimRow> = {}) => {
    claim = { uninstalled_at: null, installed_sha256: SHA, ...overrides };
  };

  const arrangeCatalogRisk = (permissionSlug: string, riskLevel: RiskLevel) => {
    catalogRisk.set(permissionSlug, riskLevel);
  };

  /**
   * Every server-scope request pending at its catalog risk, as the classifier
   * reports a Server unit's requests: only the ones its coordinates address.
   */
  const classification = (
    _pluginId: string,
    _unit: unknown,
    requested: { canonicalSlug: string; consentScope: string }[],
  ) =>
    Promise.resolve<ConsentCheckClassification>({
      decisions: new Map(
        requested
          .filter((check) => check.consentScope === 'server')
          .map((check) => [
            check.canonicalSlug,
            { decision: 'pending', decidedRiskLevel: null, staleRisk: false, ungrantable: null },
          ]),
      ),
      currentRiskBySlug: new Map(
        requested.map((check) => [check.canonicalSlug, catalogRisk.get(check.canonicalSlug) ?? RiskLevel.Low]),
      ),
    });

  beforeEach(() => {
    order = [];
    claim = undefined;
    standing = [];
    catalogRisk = new Map();

    db = createMockDatabaseService();
    db.$transaction.mockImplementation((cb) => cb(db));
    arrangePlugin();
    arrangeClaim();

    db.$queryRaw.mockImplementation(((query: unknown) => {
      const sql = rawQueryText(query);

      if (sql.includes('FROM plugins')) {
        order.push('plugin claim');
        return Promise.resolve(claim === undefined ? [] : [claim]);
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

    classifier = {
      classify: jest.fn((...args: Parameters<typeof classification>) => {
        order.push('classify');
        return classification(...args);
      }),
    };
    authority = { isServerAdmin: jest.fn().mockResolvedValue(true) };
    emitter = { emit: jest.fn() };

    service = new PluginServerConsentActService(
      db as never,
      classifier as unknown as PluginConsentCheckClassifier,
      authority as unknown as PluginGrantAuthorityService,
      { getCorrelationId: () => 'corr-1' } as unknown as AuditContextService,
      emitter as never,
      options,
    );
  });

  const emitted = () => emitter.emit.mock.calls.map(([name, event]) => ({ name, event }));

  /** Nothing reached the tables a server consent act writes. */
  const expectNothingWritten = () => {
    expect(db.pluginConsentAct.create).not.toHaveBeenCalled();
    expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  };

  describe('before the transaction', () => {
    it('refuses an unknown plugin as not found, before asking who the actor is (#1336)', async () => {
      db.plugin.findUnique.mockResolvedValue(null);

      await expect(service.toggle(input())).rejects.toBeInstanceOf(PluginUnitPluginNotFoundError);
      expect(authority.isServerAdmin).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses an uninstalled plugin as gone (#1336)', async () => {
      arrangePlugin({ uninstalledAt: new Date(1) });

      await expect(service.review(input())).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("refuses anyone who is not a server admin with the Server switch's refusal, ahead of a stale sha (#1336)", async () => {
      authority.isServerAdmin.mockResolvedValue(false);

      await expect(service.toggle(input({ actorId: 'user-1', manifestSha256: 'sha-elsewhere' }))).rejects.toEqual(
        expect.objectContaining({ constructor: PluginLifecycleAuthorityError, actorId: 'user-1' }),
      );
      expect(authority.isServerAdmin).toHaveBeenCalledWith('user-1');
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses the staged sha as stale before opening a transaction (#1336)', async () => {
      // The Server unit consents to a staged update by approving it, so a
      // server act answers only the active manifest.
      arrangePlugin({ pendingSha256: STAGED_SHA, pendingVersion: '1.3.0', pendingManifestJson: manifest as never });

      await expect(service.review(input({ manifestSha256: STAGED_SHA }))).rejects.toMatchObject({
        name: 'PluginConsentActStaleError',
        kind: 'manifest',
      });
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('refuses any other sha as stale before opening a transaction (#1336)', async () => {
      await expect(service.toggle(input({ manifestSha256: 'sha-elsewhere' }))).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }),
      );
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('the transaction', () => {
    it('claims the plugin row, classifies, reads what stands, then writes one act and its decisions in permission order (#1336)', async () => {
      const result = await service.review(input({ answers: [granted(SECOND_OPTIONAL), granted(OPTIONAL)] }));

      // No household row, no advisory key and no unit enablement: the Server
      // unit has none of them.
      expect(order).toEqual([
        'plugin claim',
        'classify',
        'standing read',
        'act',
        `grant:${OPTIONAL}`,
        `grant:${SECOND_OPTIONAL}`,
      ]);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(classifier.classify).toHaveBeenCalledWith('plugin-1', SERVER_PLUGIN_UNIT, expect.any(Array), {
        source: 'active',
        client: db,
      });

      const [[{ data: act }]] = db.pluginConsentAct.create.mock.calls as unknown as [
        [{ data: Record<string, unknown> }],
      ];
      expect(act).toEqual(
        expect.objectContaining({
          pluginId: 'plugin-1',
          pluginSlug: 'demo-sink',
          scopeType: PluginGrantScope.Server,
          scopeId: SERVER_SCOPE_SENTINEL,
          kind: 'Review',
          manifestVersion: '1.2.0',
          manifestSha256: SHA,
          decidedById: 'admin-1',
          correlationId: 'corr-1',
        }),
      );
      // The consent surface the act records is the Server unit's: its own
      // requests, never the household's.
      expect(act['presentation']).toEqual({
        locale: 'en',
        source: 'active',
        checks: [
          expect.objectContaining({ slug: REQUIRED, required: true, outcome: 'unanswered' }),
          expect.objectContaining({ slug: OPTIONAL, required: false, outcome: 'granted' }),
          expect.objectContaining({ slug: SECOND_OPTIONAL, required: false, outcome: 'granted' }),
        ],
      });

      const upserts = db.pluginGrant.upsert.mock.calls.map(([args]) => args) as unknown as {
        where: Record<string, unknown>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }[];
      expect(upserts).toHaveLength(2);
      for (const upsert of upserts) {
        expect(upsert.where).toEqual({
          pluginId_scopeType_scopeId_permissionSlug: expect.objectContaining({
            pluginId: 'plugin-1',
            scopeType: PluginGrantScope.Server,
            scopeId: SERVER_SCOPE_SENTINEL,
          }),
        });
        expect(upsert.create).toEqual(
          expect.objectContaining({
            scopeType: PluginGrantScope.Server,
            scopeId: SERVER_SCOPE_SENTINEL,
            actId: 'act-1',
            decidedById: 'admin-1',
            status: PluginGrantStatus.Granted,
            decidedRiskLevel: RiskLevel.Low,
          }),
        );
        expect(upsert.update).toEqual(expect.objectContaining({ actId: 'act-1', decidedById: 'admin-1' }));
        expect(upsert.create['decidedAt']).toBe(act['decidedAt']);
      }

      expect(result).toEqual({ act: expect.objectContaining({ id: 'act-1' }), changed: true });
    });

    it('refuses when the claim finds the plugin row gone, uninstalled or moved off the named sha, and writes nothing (#1336)', async () => {
      claim = undefined;
      await expect(service.toggle(input())).rejects.toBeInstanceOf(PluginUnitPluginNotFoundError);

      arrangeClaim({ uninstalled_at: new Date(1) });
      await expect(service.toggle(input())).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);

      // An activation that committed after the read before the transaction.
      arrangeClaim({ installed_sha256: 'sha-newer' });
      await expect(service.toggle(input())).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActStaleError, kind: 'manifest' }),
      );

      expect(classifier.classify).not.toHaveBeenCalled();
      expectNothingWritten();
    });

    it('answers changed: false and writes nothing when the toggle already stands (#1336)', async () => {
      standing = [serverRow(OPTIONAL, PluginGrantStatus.Denied, RiskLevel.Low)];

      const result = await service.toggle(input({ answers: [denied(OPTIONAL, RiskLevel.Low)] }));

      expect(result).toEqual({ act: null, changed: false });
      expect(order).toEqual(['plugin claim', 'classify', 'standing read']);
      expectNothingWritten();
    });

    it('records a toggle whose decision stands at a lower risk, the risk being part of the decision (#1336)', async () => {
      arrangeCatalogRisk(OPTIONAL, RiskLevel.High);
      standing = [serverRow(OPTIONAL, PluginGrantStatus.Denied, RiskLevel.Low)];

      const result = await service.toggle(input({ answers: [denied(OPTIONAL, RiskLevel.High)] }));

      expect(result.changed).toBe(true);
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
    });

    it('refuses a review whose shown risk is no longer the current one, and writes nothing (#1336)', async () => {
      arrangeCatalogRisk(SECOND_OPTIONAL, RiskLevel.Critical);

      await expect(
        service.review(input({ answers: [granted(SECOND_OPTIONAL, RiskLevel.High)] })),
      ).rejects.toMatchObject({
        name: 'PluginConsentActStaleError',
        kind: 'risk',
      });
      expectNothingWritten();
    });

    it('refuses a review that denies anything, since the Server unit refuses by toggling (#1336)', async () => {
      await expect(service.review(input({ answers: [denied(OPTIONAL)] }))).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActAnswerError, rule: 'server-refusal' }),
      );
      expectNothingWritten();
    });

    it('refuses a toggle of a required permission (#1336)', async () => {
      await expect(service.toggle(input({ answers: [denied(REQUIRED)] }))).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActAnswerError, rule: 'toggle-required' }),
      );
      expectNothingWritten();
    });

    it('refuses an answer for a permission a household decides (#1336)', async () => {
      await expect(service.toggle(input({ answers: [granted(HOUSEHOLD_OPTIONAL)] }))).rejects.toEqual(
        expect.objectContaining({ constructor: PluginConsentActAnswerError, rule: 'not-requested' }),
      );
      expectNothingWritten();
    });

    it('does not replay the transaction when Postgres picks it as a deadlock victim (#1336)', async () => {
      // The server act takes the plugin row and then the grant rows in
      // permission order, the order activation takes them in, so it carries
      // no deadlock retry: an aborted act reaches the caller as it is.
      db.$transaction.mockImplementationOnce(() => Promise.reject(deadlock()));

      await expect(service.toggle(input())).rejects.toThrow();
      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expectNothingWritten();
    });
  });

  describe('after the commit', () => {
    it('announces each decision whose row changed with the act, and none that stood (#1336)', async () => {
      arrangeCatalogRisk(OPTIONAL, RiskLevel.High);
      standing = [
        serverRow(OPTIONAL, PluginGrantStatus.Granted, RiskLevel.Low),
        serverRow(SECOND_OPTIONAL, PluginGrantStatus.Granted, RiskLevel.Low),
      ];

      const result = await service.review(
        input({ answers: [granted(OPTIONAL, RiskLevel.High), granted(SECOND_OPTIONAL)] }),
      );

      // Both rows are written, so each names the act that last set it; only
      // the one whose risk moved is announced.
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(2);
      expect(result.changed).toBe(true);
      expect(emitted()).toHaveLength(1);

      const [{ name, event }] = emitted();
      expect(name).toBe(PluginGrantCreatedEvent.eventName);
      expect(event).toBeInstanceOf(PluginGrantCreatedEvent);
      expect(event.context).toEqual({ manifestVersion: '1.2.0', actId: 'act-1' });
      expect(event.before).toEqual(expect.objectContaining({ decidedRiskLevel: RiskLevel.Low }));
      expect(event.after).toEqual(expect.objectContaining({ decidedRiskLevel: RiskLevel.High }));
    });

    it('announces a refusal as a rejection, with no before for a decision made for the first time (#1336)', async () => {
      await service.toggle(input({ answers: [denied(OPTIONAL)] }));

      const [{ name, event }] = emitted();
      expect(name).toBe(PluginGrantRejectedEvent.eventName);
      expect(event.before).toBeNull();
      expect(event.after).toEqual(expect.objectContaining({ status: PluginGrantStatus.Denied }));
      expect(event.context).toEqual({ manifestVersion: '1.2.0', actId: 'act-1' });
    });
  });

  describe('the Server switch', () => {
    it('toggles while the Server switch is off (#1336)', async () => {
      arrangePlugin({ enabled: false });

      await expect(service.toggle(input({ answers: [denied(OPTIONAL, RiskLevel.Low)] }))).resolves.toMatchObject({
        changed: true,
      });
    });

    it('reviews while the Server switch is off (#1336)', async () => {
      arrangePlugin({ enabled: false });

      await expect(service.review(input({ answers: [granted(OPTIONAL)] }))).resolves.toMatchObject({
        changed: true,
      });
    });
  });
});
