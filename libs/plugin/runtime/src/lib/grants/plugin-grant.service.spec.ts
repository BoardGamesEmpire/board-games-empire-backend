import type { Permission, Plugin, PluginGrant, PluginPermission } from '@bge/database';
import { DatabaseService, PERMISSION_CATALOG, PluginGrantScope, PluginGrantStatus, RiskLevel } from '@bge/database';
import { deadlock } from '@bge/database/testing';
import { createMockDatabaseService, rawQueryText, type MockDatabaseService } from '@bge/testing';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginGrantCreatedEvent, PluginGrantRejectedEvent } from '../events/plugin.events';
import { type ClaimedPluginRow } from '../manifest/manifest-move';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import {
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantManifestInvalidError,
  PluginGrantPluginChangedError,
  PluginGrantPluginNotFoundError,
  PluginGrantPluginTombstonedError,
  PluginGrantRequiredDenialError,
  PluginGrantUnknownPermissionError,
} from './grant.errors';
import { PluginGrantAuthorityService } from './plugin-grant-authority.service';
import { PluginGrantService } from './plugin-grant.service';

describe('PluginGrantService', () => {
  const options = buildPluginModuleOptions();

  /**
   * Household-scope manifest requesting at every consent scope:
   * `manage:digest` (declared, server consent), `feedback:read` (core,
   * server consent), plus household- and user-consented core checks, which
   * decide() refuses because consent acts record them (#1150).
   */
  const manifest = buildPluginManifest({ scope: 'household' });
  manifest.permissions.checks = [
    ...manifest.permissions.checks,
    {
      slug: 'update:calendar',
      required: false,
      reason: { en: 'Writes digest reminders to the household calendar.' },
      consentScope: 'household',
    },
    {
      slug: 'read:public_content',
      required: false,
      reason: { en: 'Shows public content excerpts inside per-user digests.' },
      consentScope: 'user',
    },
  ];

  const plugin = {
    id: 'plg_1',
    slug: 'demo-sink',
    version: '1.2.0',
    installedAt: new Date(0),
    manifestJson: manifest,
    uninstalledAt: null,
  } as unknown as Plugin;

  /** A row of the plugin-row claim: every signal agreeing with the plugin manifest the decision read (#361). */
  const claimedRow = (overrides: Partial<ClaimedPluginRow> = {}): ClaimedPluginRow => ({
    uninstalled_at: null,
    version: '1.2.0',
    installed_at: new Date(0),
    manifest_matches: true,
    ...overrides,
  });

  const grantRow = (overrides: Partial<PluginGrant> = {}): PluginGrant =>
    ({
      id: 'grant_1',
      pluginId: 'plg_1',
      scopeType: PluginGrantScope.Server,
      scopeId: '',
      permissionSlug: 'feedback:read',
      status: PluginGrantStatus.Granted,
      decidedById: 'user-admin',
      actId: null,
      decidedAt: new Date('2026-07-27T00:00:00.000Z'),
      decidedRiskLevel: RiskLevel.Medium,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      updatedAt: new Date('2026-07-27T00:00:00.000Z'),
      ...overrides,
    }) as PluginGrant;

  let db: MockDatabaseService;
  let emitter: { emit: jest.Mock };
  let authority: jest.Mocked<Pick<PluginGrantAuthorityService, 'isServerAdmin'>>;
  let service: PluginGrantService;

  /**
   * Answers the decision's plugin-row claim with `rows` in order, one per
   * claim (the last repeats), and keeps the strict router for every other
   * statement. For a case where the replay must see a different row than the
   * first attempt (#361).
   */
  const claimSequence = (...rows: ClaimedPluginRow[]): void => {
    const route = db.$queryRaw.getMockImplementation() as (query: unknown) => Promise<unknown>;
    let claims = 0;

    db.$queryRaw.mockImplementation(((query: unknown) => {
      if (!rawQueryText(query).includes('manifest_matches')) {
        return route(query);
      }

      const row = rows[Math.min(claims, rows.length - 1)];

      claims += 1;

      return Promise.resolve([row]);
    }) as never);
  };

  beforeEach(() => {
    db = createMockDatabaseService();
    db.$transaction.mockImplementation((cb) => cb(db));
    db.plugin.findUnique.mockResolvedValue(plugin);

    // Routes `$queryRaw` by what it reads: the decision's plugin-row claim
    // (#398, #361) answers with the signals it compares (`manifest_matches`).
    // A server decision takes no household lock and reads no unit enablement
    // (#1149, #1150), so any other raw statement fails loudly rather than
    // matching a route by accident.
    db.$queryRaw.mockImplementation(((query: unknown) => {
      const sql = rawQueryText(query);

      if (sql.includes('manifest_matches')) {
        return Promise.resolve([claimedRow()]);
      }

      throw new Error(`Unrouted $queryRaw in test: ${sql}`);
    }) as never);
    db.permission.findUnique.mockResolvedValue({
      slug: 'feedback:read',
      subject: 'FeedbackSubmission',
      riskLevel: RiskLevel.Medium,
    } as Permission);
    db.pluginPermission.findUnique.mockResolvedValue({
      id: 'plgperm_1',
      pluginId: 'plg_1',
      slug: 'plugin|demo-sink|manage:digest',
      riskLevel: RiskLevel.Low,
    } as PluginPermission);
    db.pluginGrant.findUnique.mockResolvedValue(null);
    db.pluginGrant.upsert.mockResolvedValue(grantRow());

    emitter = { emit: jest.fn() };
    authority = {
      isServerAdmin: jest.fn(),
    } satisfies Partial<jest.Mocked<PluginGrantAuthorityService>> as jest.Mocked<
      Pick<PluginGrantAuthorityService, 'isServerAdmin'>
    >;
    authority.isServerAdmin.mockResolvedValue(true);

    service = new PluginGrantService(
      db as unknown as DatabaseService,
      authority as unknown as PluginGrantAuthorityService,
      emitter as unknown as EventEmitter2,
      options,
    );
  });

  const serverDecision = {
    slug: 'demo-sink',
    permissionSlug: 'feedback:read',
    status: PluginGrantStatus.Granted,
    deciderId: 'user-admin',
  } as const;

  describe('decide — the plugin-row claim (#398)', () => {
    it('claims the plugin row FOR SHARE before it writes the grant row', async () => {
      await service.decide(serverDecision);

      const [[template, boundManifest, boundId]] = db.$queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][];
      const sql = template.join('?').replace(/\s+/g, ' ').trim();

      expect(sql).toBe(
        'SELECT uninstalled_at, version, installed_at, manifest_json = ?::jsonb AS manifest_matches FROM plugins WHERE id = ? FOR SHARE',
      );
      expect([boundManifest, boundId]).toEqual([JSON.stringify(manifest), 'plg_1']);

      // The whole point of the claim is WHERE it sits: the grant INSERT takes
      // an implicit FOR KEY SHARE on this row through the FK, and it takes it
      // AFTER the grant tuple is written. Claiming the row after the upsert
      // would leave that inversion — and the deadlock — in place.
      const claim = db.$queryRaw.mock.invocationCallOrder[0];

      expect(claim).toBeLessThan(db.pluginGrant.upsert.mock.invocationCallOrder[0]);
      expect(claim).toBeLessThan(db.pluginGrant.findUnique.mock.invocationCallOrder[0]);
    });

    it('refuses a deadlock replay whose plugin manifest moved since the first attempt read it (#361)', async () => {
      const activated = {
        ...plugin,
        version: '1.4.0',
        manifestJson: { ...manifest, version: '1.4.0' },
      } as unknown as Plugin;

      db.plugin.findUnique.mockResolvedValueOnce(plugin).mockResolvedValue(activated);
      db.pluginGrant.upsert.mockRejectedValueOnce(deadlock()).mockResolvedValue(grantRow());

      // The first attempt claims a row still at 1.2.0, then loses the deadlock.
      // An activation to 1.4.0 commits before the replay's claim.
      claimSequence(claimedRow({ version: '1.2.0' }), claimedRow({ version: '1.4.0', manifest_matches: false }));

      const failure = await service.decide(serverDecision).catch((err: unknown) => err);

      // A deadlock means a writer of this plugin row was live, most often an
      // activation. A replay that read again would record consent against
      // 1.4.0, which the client never saw, and answer 200. Judged against the
      // first read, it refuses the move like any other request would.
      expect(failure).toBeInstanceOf(PluginGrantPluginChangedError);
      expect(failure).toMatchObject({ expectedVersion: '1.2.0', actualVersion: '1.4.0' });
      expect(db.plugin.findUnique).toHaveBeenCalledTimes(1);
      expect(db.$transaction).toHaveBeenCalledTimes(2);
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('runs the decision again when the first attempt is the deadlock victim', async () => {
      db.pluginGrant.upsert.mockRejectedValueOnce(deadlock()).mockResolvedValue(grantRow());

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
      expect(db.$transaction).toHaveBeenCalledTimes(2);
      // The replay judges against the request's first read (#361).
      expect(db.plugin.findUnique).toHaveBeenCalledTimes(1);
    });

    it('propagates a second deadlock rather than looping on it', async () => {
      const second = deadlock();

      db.pluginGrant.upsert.mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(second);

      await expect(service.decide(serverDecision)).rejects.toBe(second);
      expect(db.$transaction).toHaveBeenCalledTimes(2);
    });

    it('does not retry a failure that is not a deadlock', async () => {
      const boom = new Error('not a deadlock');

      db.pluginGrant.upsert.mockRejectedValue(boom);

      await expect(service.decide(serverDecision)).rejects.toBe(boom);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('decide — the claim is the plugin manifest check (#361)', () => {
    /** Answers the decision's plugin-row claim with `row` and keeps the strict router for every other statement. */
    const claimAnswers = (row: ClaimedPluginRow | null) => {
      const route = db.$queryRaw.getMockImplementation() as (query: unknown) => Promise<unknown>;

      db.$queryRaw.mockImplementation(((query: unknown) =>
        rawQueryText(query).includes('manifest_matches')
          ? Promise.resolve(row === null ? [] : [row])
          : route(query)) as never);
    };

    it('refuses a decision whose plugin was uninstalled while it waited on the claim (#361)', async () => {
      claimAnswers(claimedRow({ uninstalled_at: new Date('2026-08-10T00:00:00Z') }));

      await expect(service.decide(serverDecision)).rejects.toBeInstanceOf(PluginGrantPluginTombstonedError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('reports a plugin row that vanished as not found (#361)', async () => {
      claimAnswers(null);

      await expect(service.decide(serverDecision)).rejects.toBeInstanceOf(PluginGrantPluginNotFoundError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });

    it('refuses a decision judged against a plugin manifest replaced at the same version (#361)', async () => {
      claimAnswers(claimedRow({ manifest_matches: false }));

      const failure = await service.decide(serverDecision).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginGrantPluginChangedError);
      expect(failure).toMatchObject({
        pluginSlug: 'demo-sink',
        kind: 'version-activated',
        expectedVersion: '1.2.0',
        actualVersion: '1.2.0',
      });
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses after a reinstall as reinstalled (#361)', async () => {
      claimAnswers(claimedRow({ installed_at: new Date(1) }));

      await expect(service.decide(serverDecision)).rejects.toMatchObject({
        name: 'PluginGrantPluginChangedError',
        kind: 'reinstalled',
      });
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });

    it('refuses a server-scope denial against a moved plugin manifest, without recording it (#361)', async () => {
      claimAnswers(claimedRow({ version: '1.3.0', manifest_matches: false }));

      await expect(service.decide({ ...serverDecision, status: PluginGrantStatus.Denied })).rejects.toMatchObject({
        name: 'PluginGrantPluginChangedError',
        kind: 'version-activated',
        actualVersion: '1.3.0',
      });
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('does not retry a plugin manifest move as if it were a deadlock (#361)', async () => {
      claimAnswers(claimedRow({ manifest_matches: false }));

      await expect(service.decide(serverDecision)).rejects.toBeInstanceOf(PluginGrantPluginChangedError);
      expect(db.plugin.findUnique).toHaveBeenCalledTimes(1);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    it('accepts the retry once the read matches, judged against the new plugin manifest (#361)', async () => {
      const activated = {
        ...plugin,
        version: '1.3.0',
        manifestJson: { ...manifest, version: '1.3.0' },
      } as unknown as Plugin;
      claimSequence(claimedRow({ version: '1.3.0', manifest_matches: false }), claimedRow({ version: '1.3.0' }));
      db.plugin.findUnique.mockResolvedValueOnce(plugin).mockResolvedValue(activated);

      await expect(service.decide(serverDecision)).rejects.toBeInstanceOf(PluginGrantPluginChangedError);
      await expect(service.decide(serverDecision)).resolves.toMatchObject({ changed: true });
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
      // The row no longer stores the version (#1150); the event states it.
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginEvent.GrantCreated,
        expect.objectContaining({ context: { manifestVersion: '1.3.0', actId: null } }),
      );
    });

    describe('a catalog row deleted by the move the claim reports (#361)', () => {
      // Activation deletes the catalog rows of the declares it drops, and
      // uninstall deletes them all. Both hold the plugin row exclusively, so
      // looked up before the claim, the catalog can already reflect a move the
      // claim has yet to report. The client would get a 422 for a permission
      // its own consent screen listed, instead of the 409 or 410 that tells it
      // the screen is out of date.
      const pluginDeclared = { ...serverDecision, permissionSlug: 'plugin|demo-sink|manage:digest' } as const;

      it('reports an activation that dropped the permission as the plugin manifest move', async () => {
        db.pluginPermission.findUnique.mockResolvedValue(null);
        claimAnswers(claimedRow({ version: '1.3.0', manifest_matches: false }));

        await expect(service.decide(pluginDeclared)).rejects.toMatchObject({
          name: 'PluginGrantPluginChangedError',
          kind: 'version-activated',
          actualVersion: '1.3.0',
        });
        expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      });

      it('reports an uninstall that purged the catalog as the uninstall', async () => {
        db.pluginPermission.findUnique.mockResolvedValue(null);
        claimAnswers(claimedRow({ uninstalled_at: new Date('2026-08-10T00:00:00Z') }));

        await expect(service.decide(pluginDeclared)).rejects.toBeInstanceOf(PluginGrantPluginTombstonedError);
        expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      });

      it('reports the move on a deadlock replay, whose first read predates the deletion', async () => {
        // The first attempt finds the row and loses a deadlock to an
        // activation that drops the permission; the replay judges against the
        // first read, so only its claim can say what happened.
        db.pluginPermission.findUnique
          .mockResolvedValueOnce({
            id: 'plgperm_1',
            pluginId: 'plg_1',
            slug: 'plugin|demo-sink|manage:digest',
            riskLevel: RiskLevel.Low,
          } as PluginPermission)
          .mockResolvedValue(null);
        db.pluginGrant.upsert.mockRejectedValueOnce(deadlock());
        claimSequence(claimedRow(), claimedRow({ version: '1.3.0', manifest_matches: false }));

        await expect(service.decide(pluginDeclared)).rejects.toBeInstanceOf(PluginGrantPluginChangedError);
        expect(db.$transaction).toHaveBeenCalledTimes(2);
        expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
      });

      it('reads the risk level under the claim, so a matching claim finds the row it declares', async () => {
        await service.decide(pluginDeclared);

        expect(db.pluginPermission.findUnique.mock.invocationCallOrder[0]).toBeGreaterThan(
          db.$queryRaw.mock.invocationCallOrder[0],
        );
      });
    });

    it('decides for a disabled plugin (#361)', async () => {
      db.plugin.findUnique.mockResolvedValue({ ...plugin, enabled: false } as unknown as Plugin);

      await expect(service.decide(serverDecision)).resolves.toMatchObject({ changed: true });
      expect(db.pluginGrant.upsert).toHaveBeenCalled();
    });
  });

  // Household and user consent decisions are recorded by consent acts now
  // (PluginConsentActService, #1150); decide() is the server's alone.
  describe('decide — server scope only (#1150)', () => {
    it.each([
      ['household', 'update:calendar', PluginGrantScope.Household],
      ['user', 'read:public_content', PluginGrantScope.User],
    ] as const)(
      'refuses a decision on a permission consented at household or user scope (#1150): %s',
      async (_scope, permissionSlug, expected) => {
        const failure = await service.decide({ ...serverDecision, permissionSlug }).catch((err: unknown) => err);

        expect(failure).toBeInstanceOf(PluginGrantConsentScopeMismatchError);
        expect(failure).toMatchObject({ permissionSlug, expected, received: PluginGrantScope.Server });
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
        expect(emitter.emit).not.toHaveBeenCalled();
      },
    );

    it('takes no household lock and writes no unit enablement (#1150)', async () => {
      await service.decide(serverDecision);

      const rawSql = db.$queryRaw.mock.calls.map(([query]) => rawQueryText(query));
      const unitCalls = [...Object.values(db.householdPlugin), ...Object.values(db.userPlugin)].flatMap((method) =>
        jest.isMockFunction(method) ? method.mock.calls : [],
      );

      // The plugin-row claim is the only raw statement: no household share
      // lock and no unit-scope advisory key.
      expect(rawSql).toHaveLength(1);
      expect(rawSql[0]).toContain('FROM plugins');
      expect(rawSql.some((sql) => sql.includes('FROM households'))).toBe(false);
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(unitCalls).toEqual([]);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ scopeType: PluginGrantScope.Server, scopeId: '' }),
        }),
      );
    });

    it('verifies the decider is a server admin (#1150)', async () => {
      await service.decide(serverDecision);

      expect(authority.isServerAdmin).toHaveBeenCalledWith('user-admin');
    });
  });

  describe('decide — happy paths', () => {
    it('creates a Server-scope grant with the sentinel scopeId, the manifest version, and the resolved core risk', async () => {
      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            pluginId: 'plg_1',
            scopeType: PluginGrantScope.Server,
            scopeId: '',
            permissionSlug: 'feedback:read',
            status: PluginGrantStatus.Granted,
            decidedById: 'user-admin',
            decidedRiskLevel: RiskLevel.Medium,
          }),
          update: expect.objectContaining({ status: PluginGrantStatus.Granted, decidedRiskLevel: RiskLevel.Medium }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(PluginEvent.GrantCreated, expect.any(PluginGrantCreatedEvent));
      // The row no longer stores the version (#1150); the event states it.
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginEvent.GrantCreated,
        expect.objectContaining({ context: { manifestVersion: '1.2.0', actId: null } }),
      );
    });

    it('resolves plugin-declared risk from the PluginPermission catalog for canonical own-namespace slugs', async () => {
      await service.decide({ ...serverDecision, permissionSlug: 'plugin|demo-sink|manage:digest' });

      expect(db.pluginPermission.findUnique).toHaveBeenCalledWith({
        where: { slug: 'plugin|demo-sink|manage:digest' },
      });
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ decidedRiskLevel: RiskLevel.Low }) }),
      );
    });

    it('a denial writes a Denied row and emits the rejection event', async () => {
      await service.decide({ ...serverDecision, status: PluginGrantStatus.Denied });

      expect(emitter.emit).toHaveBeenCalledWith(PluginEvent.GrantRejected, expect.any(PluginGrantRejectedEvent));
    });

    it('a polarity flip updates the existing row in place and emits with the prior snapshot', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(grantRow({ status: PluginGrantStatus.Denied }));

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
      expect(db.pluginGrant.upsert).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        PluginEvent.GrantCreated,
        expect.objectContaining({ before: expect.objectContaining({ status: PluginGrantStatus.Denied }) }),
      );
    });

    it('an exact re-statement is idempotent: no write, no event', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(grantRow());

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(false);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    // The decision row no longer stores a manifest version (#1150): the same
    // status at the same risk is a re-statement, and a risk the unit did not
    // consent under is what makes the decision new.
    it('a decision at a DIFFERENT risk rewrites the row even when the polarity is unchanged (#1150)', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(grantRow({ decidedRiskLevel: RiskLevel.Low }));

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
      expect(db.pluginGrant.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ decidedRiskLevel: RiskLevel.Medium }) }),
      );
    });
  });

  describe('decide — required-denial rule (D-AV, #322)', () => {
    it('refuses a Denied decision on a check the ACTIVE manifest requires at server scope, naming the levers', async () => {
      const failure = await service
        .decide({
          ...serverDecision,
          permissionSlug: 'plugin|demo-sink|manage:digest',
          status: PluginGrantStatus.Denied,
        })
        .catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PluginGrantRequiredDenialError);
      expect(failure).toMatchObject({ pluginSlug: 'demo-sink', permissionSlug: 'plugin|demo-sink|manage:digest' });
      expect((failure as Error).message).toMatch(/disable or uninstall/i);
      // Refused BEFORE the transaction: nothing written, nothing emitted —
      // the grant table stays contradiction-free by never seeing the row.
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('refuses the polarity FLIP too — an existing Granted row does not license the contradiction', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(
        grantRow({ permissionSlug: 'plugin|demo-sink|manage:digest', decidedRiskLevel: RiskLevel.Low }),
      );

      await expect(
        service.decide({
          ...serverDecision,
          permissionSlug: 'plugin|demo-sink|manage:digest',
          status: PluginGrantStatus.Denied,
        }),
      ).rejects.toThrow(PluginGrantRequiredDenialError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });

    it('a denial against a permission only the PENDING manifest requires stays legal — upgrades never coerce the installed plugin', async () => {
      // The staged update promotes feedback:read to required; the ACTIVE
      // manifest — the one decide() judges against — keeps it optional.
      // Activation stays blocked at approve (D-AB) instead.
      const pending = buildPluginManifest();
      pending.version = '1.3.0';
      pending.permissions.checks = pending.permissions.checks.map((check) =>
        check.slug === 'feedback:read' ? { ...check, required: true } : check,
      );
      db.plugin.findUnique.mockResolvedValue({
        ...plugin,
        pendingVersion: '1.3.0',
        pendingManifestJson: pending,
      } as unknown as Plugin);

      const result = await service.decide({ ...serverDecision, status: PluginGrantStatus.Denied });

      expect(result.changed).toBe(true);
      expect(emitter.emit).toHaveBeenCalledWith(PluginEvent.GrantRejected, expect.any(PluginGrantRejectedEvent));
    });
  });

  describe('decide — authority', () => {
    it('rejects a Server-scope decision from a non-admin', async () => {
      authority.isServerAdmin.mockResolvedValue(false);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantAuthorityError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });
  });

  describe('decide — categorical exclusions', () => {
    it.each(['manage:plugin', 'manage:plugin:household'])(
      "hard-refuses the plugin-administration slug '%s' regardless of consent",
      async (slug) => {
        const admin = buildPluginManifest();
        admin.permissions.checks = [
          { slug, required: false, reason: { en: 'Attempts to administer the plugin subsystem itself.' } },
        ];
        db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: admin } as unknown as Plugin);

        await expect(service.decide({ ...serverDecision, permissionSlug: slug })).rejects.toThrow(
          PluginGrantExclusionError,
        );
        expect(db.permission.findUnique).not.toHaveBeenCalled();
      },
    );

    it("refuses a core permission whose subject is the 'all' wildcard", async () => {
      db.permission.findUnique.mockResolvedValue({
        slug: 'feedback:read',
        subject: 'all',
        riskLevel: RiskLevel.Critical,
      } as Permission);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantExclusionError);
    });

    it('a condition-free core permission IS decidable at server scope — server consent is server-wide authority', async () => {
      db.permission.findUnique.mockResolvedValue({
        slug: 'feedback:read',
        subject: 'FeedbackSubmission',
        riskLevel: RiskLevel.Medium,
        conditions: null,
      } as Permission);

      await expect(service.decide(serverDecision)).resolves.toMatchObject({ changed: true });
      expect(db.pluginGrant.upsert).toHaveBeenCalled();
    });

    it.each(['manage:plugin', 'manage:plugin:household'])(
      "the administration exclusion applies to the BARE form of a DECLARED permission ('%s') — the plugin-origin route is not a bypass",
      async (bareSlug) => {
        const declared = buildPluginManifest({ permissions: { declares: [bareSlug], checks: [] } });
        declared.permissions.checks = [
          { slug: bareSlug, required: false, reason: { en: 'Declares an administration-shaped permission.' } },
        ];
        db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: declared } as unknown as Plugin);

        await expect(
          service.decide({ ...serverDecision, permissionSlug: `plugin|demo-sink|${bareSlug}` }),
        ).rejects.toThrow(PluginGrantExclusionError);
        expect(db.pluginPermission.findUnique).not.toHaveBeenCalled();
      },
    );

    it("refuses a declared permission claiming the 'all' subject — a naive CASL mapping would read wildcard authority", async () => {
      const declared = buildPluginManifest({ permissions: { declares: ['manage:all'], checks: [] } });
      declared.permissions.checks = [
        { slug: 'manage:all', required: false, reason: { en: 'Claims the universal subject for itself.' } },
      ];
      db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: declared } as unknown as Plugin);

      await expect(
        service.decide({ ...serverDecision, permissionSlug: 'plugin|demo-sink|manage:all' }),
      ).rejects.toThrow(PluginGrantExclusionError);
      expect(db.pluginPermission.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('decide — server consent is server-wide authority (#591)', () => {
    /** The catalog entry as its `Permission` row would carry it, real conditions included. */
    const catalogPermission = (slug: string): Permission => {
      const entry = PERMISSION_CATALOG.find((permission) => permission.slug === slug);

      if (!entry) {
        throw new Error(`'${slug}' is not in the permission catalog`);
      }

      const { action, subject, fields = [], conditions, riskLevel } = entry;

      return { slug, action, subject, fields, conditions, inverted: false, riskLevel } as unknown as Permission;
    };

    /** The spec's manifest, also requesting `slug` at `consentScope`. */
    const requesting = (slug: string, consentScope: 'server' | 'household' | 'user') => {
      const extended = buildPluginManifest({ scope: 'household' });
      extended.permissions.checks = [
        ...manifest.permissions.checks,
        { slug, required: false, reason: { en: 'Reads what the digest summarises.' }, consentScope },
      ];

      return { ...plugin, manifestJson: extended } as unknown as Plugin;
    };

    it('still records update:household:restore:administer at server scope — server consent is server-wide authority', async () => {
      db.plugin.findUnique.mockResolvedValue(requesting('update:household:restore:administer', 'server'));
      db.permission.findUnique.mockResolvedValue(catalogPermission('update:household:restore:administer'));

      await expect(
        service.decide({ ...serverDecision, permissionSlug: 'update:household:restore:administer' }),
      ).resolves.toMatchObject({ changed: true });
      expect(db.pluginGrant.upsert).toHaveBeenCalled();
    });
  });

  describe('decide — request validation', () => {
    it('rejects a decision for a plugin that does not exist', async () => {
      db.plugin.findUnique.mockResolvedValue(null);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantPluginNotFoundError);
    });

    it('rejects a decision for a tombstoned plugin at ANY scope (#225)', async () => {
      db.plugin.findUnique.mockResolvedValue({
        ...plugin,
        uninstalledAt: new Date('2026-07-01T00:00:00Z'),
      } as unknown as Plugin);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantPluginTombstonedError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });

    it('rejects a permission the manifest never requested', async () => {
      await expect(service.decide({ ...serverDecision, permissionSlug: 'read:game' })).rejects.toThrow(
        PluginGrantUnknownPermissionError,
      );
    });

    it('fails loudly when a declared permission has no PluginPermission catalog row', async () => {
      db.pluginPermission.findUnique.mockResolvedValue(null);

      await expect(
        service.decide({ ...serverDecision, permissionSlug: 'plugin|demo-sink|manage:digest' }),
      ).rejects.toThrow(PluginGrantUnknownPermissionError);
    });

    it('fails loudly when a core permission does not exist, hinting at a missing declare', async () => {
      db.permission.findUnique.mockResolvedValue(null);

      await expect(service.decide(serverDecision)).rejects.toThrow(/add it to permissions\.declares/);
    });

    it('a BGE upgrade past the manifest bgeCompat range does NOT block consent — decisions stay recordable', async () => {
      const outgrown = buildPluginManifest({ bgeCompat: '>=9.0.0' });
      db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: outgrown } as unknown as Plugin);

      const result = await service.decide(serverDecision);

      expect(result.changed).toBe(true);
    });

    it('wraps a genuinely invalid stored manifest in the grant-domain error, carrying the issues', async () => {
      const corrupted = buildPluginManifest({ version: 'one.two' });
      db.plugin.findUnique.mockResolvedValue({ ...plugin, manifestJson: corrupted } as unknown as Plugin);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantManifestInvalidError);
    });

    it('refuses to decide when the stored manifest slug drifted from Plugin.slug — canonical slugs would cross namespaces', async () => {
      db.plugin.findUnique.mockResolvedValue({ ...plugin, slug: 'renamed-sink' } as unknown as Plugin);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantManifestInvalidError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });

    it('refuses to decide when the stored manifest version drifted from Plugin.version — the row would be stamped with a version the checks did not come from', async () => {
      db.plugin.findUnique.mockResolvedValue({ ...plugin, version: '1.3.0' } as unknown as Plugin);

      await expect(service.decide(serverDecision)).rejects.toThrow(PluginGrantManifestInvalidError);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    });
  });
});
