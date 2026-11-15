import {
  PluginCategory,
  PluginExecutionMode,
  PluginScope,
  PluginUnitDormantReason,
  Prisma,
  type HouseholdPlugin,
  type Plugin,
  type UserPlugin,
} from '@bge/database';
import { createMockDatabaseService, rawQueryText, type MockDatabaseService } from '@bge/testing';
import { PluginEvent } from '@boardgamesempire/plugin-contract';
import { buildPluginManifest, type PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginDisabledEvent,
  UserPluginDisabledEvent,
} from '../events/plugin.events';
import type { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { buildPluginModuleOptions } from '../testing/plugin-module-options.fixture';
import { PluginUnitLifecycleService } from './plugin-unit-lifecycle.service';
import {
  PluginUnitAuthorityError,
  PluginUnitHouseholdNotFoundError,
  PluginUnitNotEnrolledError,
  PluginUnitPluginChangedError,
  PluginUnitPluginNotFoundError,
  PluginUnitPluginTombstonedError,
  PluginUnitScopeError,
} from './unit.errors';

describe('PluginUnitLifecycleService', () => {
  const options = buildPluginModuleOptions();

  /** Household-scope manifest with one REQUIRED household-consented check. */
  const householdManifest = (config?: Partial<PluginManifest['config']>): PluginManifest =>
    buildPluginManifest({
      scope: 'household',
      permissions: {
        declares: ['manage:digest'],
        checks: [
          {
            slug: 'manage:digest',
            required: true,
            reason: { en: 'Stores and manages the digest configuration it owns.' },
            consentScope: 'household',
          },
        ],
      },
      config,
    });

  interface LivingRow {
    readonly uninstalled_at: Date | null;
    readonly scope: PluginScope;
    readonly version: string;
    readonly installed_at: Date;
    readonly manifest_matches: boolean | null;
  }

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
    installedSha256: 'sha-1',
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

  /**
   * A row of the in-transaction `FOR SHARE` re-read.
   *
   * `manifest_matches` is the comparison the database performs, not a column:
   * `manifest_json = $1::jsonb` against the manifest the caller derived its
   * gates from (#368). It defaults TRUE because an unmoved manifest is the
   * ordinary case, and the guard treats anything other than TRUE as a move —
   * so a case that forgets the field refuses loudly instead of quietly
   * skipping the comparison. NULL is what the database really answers when
   * the caller passed no snapshot, and the disable case below uses it.
   */
  const livingRow = (overrides: Partial<LivingRow> = {}): LivingRow => ({
    uninstalled_at: null,
    scope: PluginScope.Household,
    version: '1.2.0',
    installed_at: new Date(0),
    manifest_matches: true,
    ...overrides,
  });

  /** Index of the first `$queryRaw` call whose SQL matches. */
  const rawCallIndex = (pattern: RegExp): number =>
    db.$queryRaw.mock.calls.findIndex((call: readonly unknown[]) => pattern.test(rawQueryText(call[0])));

  const HOUSEHOLD_LOCK = /FROM households h .* FOR SHARE/;
  const PLUGIN_ROW = /FROM plugins WHERE id = \? FOR SHARE/;

  /** The household share lock finds no live row: the household is missing or soft-deleted. */
  const householdGone = () =>
    db.$queryRaw.mockImplementation(((query: unknown) =>
      Promise.resolve(HOUSEHOLD_LOCK.test(rawQueryText(query)) ? [] : [livingRow()])) as never);

  const makeHouseholdRow = (overrides: Partial<HouseholdPlugin> = {}): HouseholdPlugin => ({
    id: 'hp-1',
    householdId: 'hh-1',
    pluginId: 'plugin-1',
    enabled: true,
    config: {},
    dormantReason: null,
    dormantAt: null,
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

  const enableInput = { slug: 'demo-sink', householdId: 'hh-1', actorId: 'admin-1' };

  let db: MockDatabaseService;
  let authority: jest.Mocked<Pick<PluginGrantAuthorityService, 'householdAdminStanding'>>;
  let emitter: { emit: jest.Mock };
  let service: PluginUnitLifecycleService;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    db = createMockDatabaseService();
    db.$transaction.mockImplementation((cb) => cb(db));
    db.plugin.findUnique.mockResolvedValue(makePlugin());
    // The in-transaction liveness re-read (FOR SHARE): alive by default.
    db.$queryRaw.mockResolvedValue([livingRow()] as never);
    db.pluginGrant.findMany.mockResolvedValue([]);
    authority = {
      householdAdminStanding: jest.fn().mockResolvedValue('admin'),
    };
    emitter = { emit: jest.fn() };

    service = new PluginUnitLifecycleService(
      db as never,
      authority as unknown as PluginGrantAuthorityService,
      new PluginConfigSchemaService(),
      emitter as never,
      options,
    );
  });

  const emittedEvents = () => emitter.emit.mock.calls.map(([name, event]) => ({ name, event }));

  // The household's switch-on is a consent act now, in PluginConsentActService
  // (#1150). The unit transaction it used to exercise here is the one the
  // config PATCH and disable still open, so the guards are pinned through them.
  describe('the household unit transaction', () => {
    const configInput = { ...enableInput, config: { webhookUrl: 'https://x' } };

    it('opens the transaction household row first: share lock, plugin-row re-read, scope lock, unit row', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.householdPlugin.update.mockResolvedValue(makeHouseholdRow());

      await service.updateHouseholdConfig(configInput);

      const [advisoryStrings, ...advisoryValues] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(rawQueryText(advisoryStrings)).toContain('pg_advisory_xact_lock(hashtextextended(');
      expect(advisoryValues).toContain('plugin_grant:household_unit:hh-1:plugin-1');

      const householdAt = rawCallIndex(HOUSEHOLD_LOCK);
      const livenessAt = rawCallIndex(PLUGIN_ROW);
      expect(rawQueryText(db.$queryRaw.mock.calls[livenessAt][0])).toContain(
        'SELECT uninstalled_at, scope, version, installed_at, manifest_json = ?::jsonb AS manifest_matches ' +
          'FROM plugins WHERE id = ? FOR SHARE',
      );

      // The household row comes first (#548): a soft-delete holds it while it
      // runs and touches no plugin table, so taking it first can only queue.
      //
      // The plugin row MUST precede the advisory lock. Uninstall and
      // activation claim that row before touching grant rows, and a consent
      // act holds grant rows while taking this advisory (#1150) —
      // advisory-first would close the cycle advisory → plugin → grant →
      // advisory, which Postgres resolves by aborting a caller.
      const householdOrder = db.$queryRaw.mock.invocationCallOrder[householdAt];
      const livenessOrder = db.$queryRaw.mock.invocationCallOrder[livenessAt];
      const advisoryOrder = db.$executeRaw.mock.invocationCallOrder[0];
      const readOrder = db.householdPlugin.findUnique.mock.invocationCallOrder[0];
      expect(householdOrder).toBeLessThan(livenessOrder);
      expect(livenessOrder).toBeLessThan(advisoryOrder);
      expect(advisoryOrder).toBeLessThan(readOrder);
    });

    it('refuses when a concurrent activation promoted a new version after the manifest was read', async () => {
      // The config was validated against 1.2.0's schema. Writing it under
      // 1.3.0 would apply a judgment against a schema that is gone.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.$queryRaw.mockResolvedValue([livingRow({ version: '1.3.0' })] as never);

      await expect(service.updateHouseholdConfig(configInput)).rejects.toMatchObject({
        name: 'PluginUnitPluginChangedError',
        kind: 'version-activated',
      });
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses a SAME-VERSION reinstall — a tombstone reinstall replaces the manifest in place', async () => {
      // The installer's reinstall branch updates manifestJson on the same
      // row at possibly the same version, stamping a fresh installedAt.
      // Version alone cannot see that, so installedAt is carried too.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.$queryRaw.mockResolvedValue([livingRow({ installed_at: new Date(9_000) })] as never);

      await expect(service.updateHouseholdConfig(configInput)).rejects.toMatchObject({
        name: 'PluginUnitPluginChangedError',
        kind: 'reinstalled',
      });
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
    });

    it('classifies a DIFFERENT-version reinstall as a reinstall, not an activation', async () => {
      // A reinstall installs whatever version it was handed, so it can move
      // version AND installedAt. installedAt is tested first because the
      // installer is its only writer — testing version first would report
      // this as an activation and tell the client consent survived, when
      // the reinstall's uninstall purged every grant.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.$queryRaw.mockResolvedValue([livingRow({ version: '1.3.0', installed_at: new Date(9_000) })] as never);

      await expect(service.updateHouseholdConfig(configInput)).rejects.toMatchObject({
        name: 'PluginUnitPluginChangedError',
        kind: 'reinstalled',
        expectedVersion: '1.2.0',
        actualVersion: '1.3.0',
      });
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
    });

    it('refuses an A-B-A activation pair: both discriminators match while the manifest content moved', async () => {
      // The residual #368 was filed for. Staging refuses only a version equal
      // to the CURRENT one, so activations away from and back to a version are
      // permitted, and that pair restores `version` while never touching
      // `installedAt` — the installer is its only writer. Both discriminators
      // therefore agree with the pre-read while `manifest_json` has been
      // replaced twice, and the config schema is a judgment made against a
      // manifest that is gone.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.$queryRaw.mockResolvedValue([livingRow({ manifest_matches: false })] as never);

      await expect(service.updateHouseholdConfig(configInput)).rejects.toMatchObject({
        name: 'PluginUnitPluginChangedError',
        // Grants SURVIVED — an activation keeps them — which is the whole of
        // what `kind` reports, so this needs no third arm.
        kind: 'version-activated',
        expectedVersion: '1.2.0',
        actualVersion: '1.2.0',
      });
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('says a re-activation REPLACED the content rather than reporting a move from a version to itself', async () => {
      // The reason `kind` staying two-valued still needs a third phrasing:
      // the version-move sentence reads 'activated from 1.2.0 to 1.2.0' here,
      // which describes nothing and reads as a bug in the guard.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.$queryRaw.mockResolvedValue([livingRow({ manifest_matches: false })] as never);

      await expect(service.updateHouseholdConfig(configInput)).rejects.toThrow(
        /re-activated at version 1\.2\.0 with different plugin manifest content/,
      );
    });

    it('compares the manifest in the DATABASE, against the document the gates were derived from', async () => {
      // `jsonb = jsonb` is a normalized comparison, so key order and spacing
      // cannot manufacture a false 409 — which a string or structural compare
      // in this process would have to reproduce for itself. Binding the
      // pre-read document (not the re-read row, and not the validated object,
      // which is a parsed product rather than the stored bytes) is what makes
      // the comparison mean 'the manifest my gates came from'.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.householdPlugin.update.mockResolvedValue(makeHouseholdRow());

      await service.updateHouseholdConfig(configInput);

      const [strings, ...values] = db.$queryRaw.mock.calls[rawCallIndex(PLUGIN_ROW)] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(rawQueryText(strings)).toContain('manifest_json = ?::jsonb AS manifest_matches');
      expect(values[0]).toEqual(JSON.stringify(makePlugin().manifestJson));
    });

    it('treats an unanswered comparison as a move', async () => {
      // Fail closed. `manifest_json` is NOT NULL and the bound document is
      // non-null whenever a snapshot was passed, so the comparison cannot
      // legitimately come back NULL here — and a guard that read 'not false'
      // as 'unchanged' would pass every row a future refactor forgot to
      // answer for.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.$queryRaw.mockResolvedValue([livingRow({ manifest_matches: null })] as never);

      await expect(service.updateHouseholdConfig(configInput)).rejects.toBeInstanceOf(PluginUnitPluginChangedError);
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
    });

    it('binds no manifest on the paths that derive nothing from one', async () => {
      // The other half of the deliberate asymmetry below: the switch-offs do
      // not merely tolerate a moved manifest, they never ask. A NULL
      // parameter makes the comparison NULL, which is why the disable case
      // can carry that row and still succeed.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow({ enabled: true }));
      db.householdPlugin.update.mockResolvedValue(makeHouseholdRow({ enabled: false }));

      await service.disableHousehold(enableInput);

      const [, ...values] = db.$queryRaw.mock.calls[rawCallIndex(PLUGIN_ROW)] as [TemplateStringsArray, ...unknown[]];
      expect(values[0]).toBeNull();
    });

    it('does NOT refuse a version move on disable — no manifest judgment rides a switch flip', async () => {
      // Deliberate asymmetry: refusing here would invent a failure for a
      // path that derived nothing from the manifest.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow({ enabled: true }));
      db.householdPlugin.update.mockResolvedValue(makeHouseholdRow({ enabled: false }));
      db.$queryRaw.mockResolvedValue([livingRow({ version: '1.3.0', manifest_matches: null })] as never);

      await expect(service.disableHousehold(enableInput)).resolves.toMatchObject({ enabled: false });
    });

    it('refuses when a concurrent activation re-scoped the plugin to server after the pre-read', async () => {
      // Activation rewrites version/scope/manifestJson together, and the
      // FOR SHARE re-read is what sees it. Household config for a
      // server-scope plugin lands on a surface the manifest gate says cannot
      // exist, so the refusal is the whole point.
      db.$queryRaw.mockResolvedValue([livingRow({ scope: PluginScope.Server })] as never);

      await expect(service.updateHouseholdConfig(configInput)).rejects.toBeInstanceOf(PluginUnitScopeError);
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      // Refused before serializing anyone else on this unit's advisory key.
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses inside the transaction when a concurrent uninstall tombstoned the plugin after the pre-read', async () => {
      // The pre-transaction load saw the plugin alive; the FOR SHARE
      // re-read is what keeps a write from committing against a plugin
      // whose purge already promised its unit rows gone.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      db.$queryRaw.mockResolvedValue([livingRow({ uninstalled_at: new Date(7) })] as never);

      await expect(service.updateHouseholdConfig(configInput)).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
    });

    it('refuses the household surface for a server-scope plugin — the scope-coherence rule at the writer', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ scope: PluginScope.Server }));

      await expect(service.updateHouseholdConfig(configInput)).rejects.toBeInstanceOf(PluginUnitScopeError);
    });

    it('refuses a non-admin of the anchoring household', async () => {
      authority.householdAdminStanding.mockResolvedValue('none');

      await expect(service.updateHouseholdConfig(configInput)).rejects.toBeInstanceOf(PluginUnitAuthorityError);
      expect(authority.householdAdminStanding).toHaveBeenCalledWith('admin-1', 'hh-1');
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it("answers the household's own admin as gone, not as refused, once it has been deleted", async () => {
      // A delete that commits after the route's liveness guard but before this
      // check leaves the actor no longer the admin of a live household. The 404
      // keeps the answer the guard and the in-transaction lock give (#553)
      // rather than a 403 that depends on which check the delete landed between.
      authority.householdAdminStanding.mockResolvedValue('deleted');

      await expect(service.updateHouseholdConfig(configInput)).rejects.toBeInstanceOf(PluginUnitHouseholdNotFoundError);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('404s an unknown slug and 410s a tombstone', async () => {
      db.plugin.findUnique.mockResolvedValue(null);
      await expect(service.updateHouseholdConfig(configInput)).rejects.toBeInstanceOf(PluginUnitPluginNotFoundError);

      db.plugin.findUnique.mockResolvedValue(makePlugin({ uninstalledAt: new Date(5) }));
      await expect(service.updateHouseholdConfig(configInput)).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);
    });
  });

  describe('disableHousehold', () => {
    it('flips the switch and emits the disabled event', async () => {
      const before = makeHouseholdRow();
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, enabled: false });

      const row = await service.disableHousehold(enableInput);

      expect(row.enabled).toBe(false);
      expect(db.householdPlugin.update).toHaveBeenCalledWith({ where: { id: 'hp-1' }, data: { enabled: false } });
      const [{ name, event }] = emittedEvents();
      expect(name).toBe(PluginEvent.Disabled);
      expect(event).toBeInstanceOf(HouseholdPluginDisabledEvent);
    });

    it('is idempotent on an already-disabled row: no write, no event', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow({ enabled: false }));

      await service.disableHousehold(enableInput);

      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("404s a household that never enabled the plugin — the household's switch-on, a consent act, is the row creator (#1150)", async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null);

      await expect(service.disableHousehold(enableInput)).rejects.toBeInstanceOf(PluginUnitNotEnrolledError);
    });

    /**
     * D-CL. The row is dormant, on the household admin's screen with a reason
     * attached (#354's list), and disable is the only operation that could act
     * on it — so this path does not require the household surface the config
     * PATCH does.
     */
    it('switches off a row the plugin scope no longer admits, where config PATCH refuses', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ scope: PluginScope.Server }));
      db.$queryRaw.mockResolvedValue([livingRow({ scope: PluginScope.Server })] as never);
      const before = makeHouseholdRow({ dormantReason: PluginUnitDormantReason.ScopeOrphaned });
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, enabled: false });

      const row = await service.disableHousehold(enableInput);

      expect(row.enabled).toBe(false);
      // The dormancy is NOT cleared by switching the row off: the two are
      // independent, and a re-scope back must restore the admin's own intent
      // rather than one this path invented.
      expect(db.householdPlugin.update).toHaveBeenCalledWith({ where: { id: 'hp-1' }, data: { enabled: false } });

      await expect(
        service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } }),
      ).rejects.toBeInstanceOf(PluginUnitScopeError);
    });
  });

  describe('updateHouseholdConfig', () => {
    it('validates against the active schema, writes last-writer-wins, and emits the config event', async () => {
      const before = makeHouseholdRow();
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, config: { webhookUrl: 'https://z' } });

      await service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } });

      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { config: { webhookUrl: 'https://z' } },
      });
      const [{ name, event }] = emittedEvents();
      expect(name).toBe(PluginEvent.ConfigUpdated);
      expect(event).toBeInstanceOf(HouseholdPluginConfigUpdatedEvent);
    });

    it('clears a config dormancy — the document that caused it has just been replaced (#370)', async () => {
      const before = makeHouseholdRow({
        config: { webhookUrl: 42 },
        dormantReason: PluginUnitDormantReason.NeedsConfiguration,
        dormantAt: new Date(0),
      });
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({
        ...before,
        config: { webhookUrl: 'https://z' },
        dormantReason: null,
        dormantAt: null,
      });

      await service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } });

      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { config: { webhookUrl: 'https://z' }, dormantReason: null, dormantAt: null },
      });
    });

    it('leaves the dormancy fields out of an ordinary write entirely', async () => {
      const before = makeHouseholdRow();
      db.householdPlugin.findUnique.mockResolvedValue(before);
      db.householdPlugin.update.mockResolvedValue({ ...before, config: { webhookUrl: 'https://z' } });

      await service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } });

      expect(db.householdPlugin.update).toHaveBeenCalledWith({
        where: { id: 'hp-1' },
        data: { config: { webhookUrl: 'https://z' } },
      });
    });

    it('rejects a schema violation with issues[] before any transaction', async () => {
      await expect(
        service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 42 } }),
      ).rejects.toBeInstanceOf(PluginConfigValidationError);
      expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('404s a household that never enabled the plugin', async () => {
      db.householdPlugin.findUnique.mockResolvedValue(null);

      await expect(
        service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } }),
      ).rejects.toBeInstanceOf(PluginUnitNotEnrolledError);
    });
  });

  describe('a household soft-deleted while the write is in flight (#548)', () => {
    const WRITERS = [
      { name: 'disable', write: () => service.disableHousehold(enableInput) },
      {
        name: 'config PATCH',
        write: () => service.updateHouseholdConfig({ ...enableInput, config: { webhookUrl: 'https://z' } }),
      },
    ];

    it.each(WRITERS)('refuses a $name once the share lock finds the household gone', async ({ write }) => {
      // Every check in front of the transaction saw the household live; the
      // lock is what sees the delete, because it waits for one in flight and
      // re-reads the row after it commits.
      db.householdPlugin.findUnique.mockResolvedValue(makeHouseholdRow());
      householdGone();

      await expect(write()).rejects.toBeInstanceOf(PluginUnitHouseholdNotFoundError);

      // Refused before it took anything else: no plugin-row claim, no key, no write.
      expect(rawCallIndex(PLUGIN_ROW)).toBe(-1);
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.householdPlugin.create).not.toHaveBeenCalled();
      expect(db.householdPlugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('names the household it could not find', async () => {
      householdGone();

      await expect(service.disableHousehold(enableInput)).rejects.toMatchObject({
        name: 'PluginUnitHouseholdNotFoundError',
        householdId: 'hh-1',
      });
    });
  });

  describe('user switch-off', () => {
    const userInput = { slug: 'demo-sink', userId: 'user-1' };

    it('disables under the user advisory lock, writing only the enabled flag, and emits the user disabled event (#1149)', async () => {
      const before = makeUserRow();
      db.userPlugin.findUnique.mockResolvedValue(before);
      db.userPlugin.update.mockResolvedValue({ ...before, enabled: false });

      const row = await service.disableUser(userInput);

      const [strings, ...values] = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      expect(rawQueryText(strings)).toContain('pg_advisory_xact_lock(hashtextextended(');
      expect(values).toContain('plugin_grant:user_unit:user-1:plugin-1');

      expect(db.userPlugin.update).toHaveBeenCalledWith({ where: { id: 'up-1' }, data: { enabled: false } });
      expect(row.enabled).toBe(false);
      const [{ name, event }] = emittedEvents();
      expect(name).toBe(PluginEvent.Disabled);
      expect(event).toBeInstanceOf(UserPluginDisabledEvent);
    });

    it('is idempotent: a matching state returns unchanged with no write, no event', async () => {
      db.userPlugin.findUnique.mockResolvedValue(makeUserRow({ enabled: false }));

      await service.disableUser(userInput);

      expect(db.userPlugin.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("404s without a unit enablement — the user's switch-on, a consent act, is its only creator (#1150)", async () => {
      db.userPlugin.findUnique.mockResolvedValue(null);

      await expect(service.disableUser(userInput)).rejects.toBeInstanceOf(PluginUnitNotEnrolledError);
    });

    it('410s a tombstoned plugin, both before the transaction and on the in-transaction re-read', async () => {
      db.plugin.findUnique.mockResolvedValue(makePlugin({ uninstalledAt: new Date(5) }));
      await expect(service.disableUser(userInput)).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);

      db.plugin.findUnique.mockResolvedValue(makePlugin());
      db.$queryRaw.mockResolvedValue([livingRow({ uninstalled_at: new Date(6) })] as never);
      await expect(service.disableUser(userInput)).rejects.toBeInstanceOf(PluginUnitPluginTombstonedError);
    });
  });
});
