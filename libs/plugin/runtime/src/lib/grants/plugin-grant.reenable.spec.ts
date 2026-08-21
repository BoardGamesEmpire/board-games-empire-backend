import {
  PluginCategory,
  PluginExecutionMode,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  Prisma,
  RiskLevel,
  type Permission,
  type Plugin,
  type PluginGrant,
} from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { buildPluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  HouseholdPluginUnitDisabledEvent,
  HouseholdPluginUnitEnabledEvent,
  PluginGrantCreatedEvent,
  UserPluginUnitDisabledEvent,
  UserPluginUnitEnabledEvent,
} from '../events/plugin.events';
import type { PluginGrantAuthorityService } from './plugin-grant-authority.service';
import { PluginGrantService, type PluginGrantDecisionInput } from './plugin-grant.service';

/**
 * Late acceptance: `decide()` clears `suspendedForConsent` and emits
 * `plugin.unit_enabled` once a unit's `Granted` decision covers every
 * required-at-scope permission of the active manifest — for household AND
 * user units (#225). Focused here rather than folded into the main decide()
 * spec — the post-effect has its own matrix. The household block carries
 * the full predicate matrix; the user block asserts the mirrored transition
 * and the one behavior unique to that scope.
 */
describe('PluginGrantService — late-acceptance re-enable post-effect', () => {
  // The fixture's household-required surface: calendar:read (required) plus
  // the baseline server checks the post-effect must ignore.
  const manifest = buildPluginManifest({
    scope: 'household',
    permissions: {
      declares: ['manage:digest'],
      checks: [
        ...buildPluginManifest().permissions.checks,
        {
          slug: 'calendar:read',
          required: true,
          reason: { en: 'Schedules digests around household events.' },
          consentScope: 'household',
        },
        {
          slug: 'notify:send',
          required: false,
          reason: { en: 'Optional notifications.' },
          consentScope: 'household',
        },
        {
          slug: 'read:user_digest',
          required: true,
          reason: { en: 'Reads the digest each member curated for themselves.' },
          consentScope: 'user',
        },
      ],
    },
  });

  const makePlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    id: 'plugin-1',
    slug: 'demo-sink',
    version: '1.2.0',
    category: PluginCategory.FeedbackSink,
    scope: PluginScope.Server,
    executionMode: PluginExecutionMode.InProcess,
    enabled: true,
    bundled: false,
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
    installedSha256: 'sha',
    registrySlug: null,
    pendingVersion: null,
    pendingManifestJson: null,
    pendingSha256: null,
    pendingSince: null,
    restartRequired: false,
    uninstalledAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  const makeGrant = (overrides: Partial<PluginGrant> = {}): PluginGrant => ({
    id: 'grant-1',
    pluginId: 'plugin-1',
    scopeType: PluginGrantScope.Household,
    scopeId: 'household-1',
    permissionSlug: 'calendar:read',
    status: PluginGrantStatus.Granted,
    decidedById: 'owner-1',
    manifestVersion: '1.2.0',
    decidedRiskLevel: RiskLevel.Low,
    decidedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  /**
   * The unit row as the mirror's `FOR UPDATE` lock returns it. Both mirror
   * directions read the row through raw SQL now (Prisma has no row-lock
   * API), so the fixture speaks the mapped snake_case the driver hands back
   * rather than a full Prisma row the code never sees.
   */
  const lockedUnit = (id: string, suspendedForConsent: boolean) => [
    { id, enabled: true, suspended_for_consent: suspendedForConsent },
  ];

  // Bounding clauses so unit-scope decisions pass the unit-boundedness gate
  // (#60); the condition-free refusal is specced in the main service suite.
  const calendarRead = {
    slug: 'calendar:read',
    subject: 'calendar',
    riskLevel: RiskLevel.Low,
    conditions: { householdId: '{{ unit.householdId }}' },
  } as unknown as Permission;

  /**
   * The re-enable predicate reads `select: { slug, riskLevel }`, but the
   * delegate mock is typed against the full row — so the projection is
   * asserted, matching how `calendarRead` above is built.
   */
  const corePermission = (slug: string, riskLevel: RiskLevel): Permission =>
    ({ slug, riskLevel, conditions: { householdId: '{{ unit.householdId }}' } }) as unknown as Permission;

  let db: MockDatabaseService;
  let emitter: { emit: jest.Mock };
  let service: PluginGrantService;

  const decision = (overrides: Partial<PluginGrantDecisionInput> = {}): PluginGrantDecisionInput => ({
    slug: 'demo-sink',
    scopeType: PluginGrantScope.Household,
    scopeId: 'household-1',
    permissionSlug: 'calendar:read',
    status: PluginGrantStatus.Granted,
    deciderId: 'owner-1',
    ...overrides,
  });

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  beforeEach(() => {
    db = createMockDatabaseService();
    const authority = {
      isServerAdmin: jest.fn().mockResolvedValue(false),
      isHouseholdAdmin: jest.fn().mockResolvedValue(true),
    } satisfies Partial<jest.Mocked<PluginGrantAuthorityService>>;
    emitter = { emit: jest.fn() };
    service = new PluginGrantService(
      db as never,
      authority as unknown as PluginGrantAuthorityService,
      emitter as never,
      {
        pluginsRoot: '/var/lib/bge/plugins',
        bundledRoot: '/srv/bge/plugins/bundled',
        bgeVersion: '0.3.0',
        defaultLocale: 'en',
      },
    );

    db.plugin.findUnique.mockResolvedValue(makePlugin());
    db.permission.findUnique.mockResolvedValue(calendarRead);
    // The re-enable predicate reads TODAY's catalog risk for core
    // household-scope checks so a stale decision cannot clear a suspension.
    db.permission.findMany.mockResolvedValue([
      corePermission('calendar:read', RiskLevel.Low),
      corePermission('notify:send', RiskLevel.Low),
    ]);
    db.pluginGrant.findUnique.mockResolvedValue(null);
    db.pluginGrant.upsert.mockResolvedValue(makeGrant());
    db.$queryRaw.mockResolvedValue(lockedUnit('hp-1', true));
    db.pluginGrant.findMany.mockResolvedValue([makeGrant()]);
    db.householdPlugin.updateMany.mockResolvedValue({ count: 1 });
    db.$transaction.mockImplementation((cb) => cb(db));
  });

  afterEach(() => jest.clearAllMocks());

  it('clears the suspension and emits unit_enabled when the decision covers the last outstanding required slug', async () => {
    await service.decide(decision());

    expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
      where: { id: 'hp-1', suspendedForConsent: true },
      data: { suspendedForConsent: false, suspendedAt: null },
    });
    expect(emitter.emit).toHaveBeenCalledWith(
      HouseholdPluginUnitEnabledEvent.eventName,
      expect.objectContaining({
        grantedPermissionSlug: 'calendar:read',
        manifestVersion: '1.2.0',
        before: expect.objectContaining({ suspendedForConsent: true }),
        after: expect.objectContaining({ suspendedForConsent: false }),
      }),
    );
  });

  it('leaves the suspension in place while required slugs remain outstanding', async () => {
    db.pluginGrant.findMany.mockResolvedValue([]);

    await service.decide(decision());

    expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitEnabledEvent.eventName, expect.anything());
  });

  it('leaves the suspension in place when a granted slug no longer covers the catalog risk', async () => {
    // notify:send is OPTIONAL and already granted — at Low, while the catalog
    // now says High. Presence of that row is not consent at today's risk, so
    // clearing the suspension here would undo the update's own escalation.
    db.pluginGrant.findMany.mockResolvedValue([
      makeGrant(),
      makeGrant({ id: 'grant-2', permissionSlug: 'notify:send', decidedRiskLevel: RiskLevel.Low }),
    ]);
    db.permission.findMany.mockResolvedValue([
      corePermission('calendar:read', RiskLevel.Low),
      corePermission('notify:send', RiskLevel.High),
    ]);

    await service.decide(decision());

    expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitEnabledEvent.eventName, expect.anything());
  });

  it('does nothing for a unit that is not suspended', async () => {
    db.$queryRaw.mockResolvedValue(lockedUnit('hp-1', false));

    await service.decide(decision());

    expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
  });

  it('a Denied decision never re-enables — the suspension mirror owns that direction (D-BQ)', async () => {
    db.pluginGrant.upsert.mockResolvedValue(makeGrant({ status: PluginGrantStatus.Denied }));

    await service.decide(decision({ status: PluginGrantStatus.Denied }));

    expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitEnabledEvent.eventName, expect.anything());
    // The fixture unit is ALREADY suspended, so the mirror has nothing to
    // flip either — no write, no unit event.
    expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
  });

  /**
   * Deliberately the opposite of what this asserted before the #359 review:
   * the mirror passes are non-fatal, so a decision whose mirror failed (or
   * never ran, if the process died between commit and mirror) leaves the
   * unit stale, and re-POSTing the same decision — the obvious repair —
   * used to return before reaching them. An unchanged decision still writes
   * no grant and emits no grant event; it now reconciles the unit, which is
   * idempotent and emits only on a real flip.
   */
  it('reconciles the unit for an unchanged (idempotent) decision — no grant write, no grant event', async () => {
    db.pluginGrant.findUnique.mockResolvedValue(makeGrant());

    const result = await service.decide(decision());

    expect(result.changed).toBe(false);
    expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalledWith(PluginGrantCreatedEvent.eventName, expect.anything());
    // The stale suspension the retry exists to repair.
    expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
      where: { id: 'hp-1', suspendedForConsent: true },
      data: { suspendedForConsent: false, suspendedAt: null },
    });
    expect(emitter.emit).toHaveBeenCalledWith(
      HouseholdPluginUnitEnabledEvent.eventName,
      expect.objectContaining({ grantedPermissionSlug: 'calendar:read' }),
    );
  });

  it('does not emit when a concurrent writer already cleared the suspension (guarded updateMany)', async () => {
    db.householdPlugin.updateMany.mockResolvedValue({ count: 0 });

    await service.decide(decision());

    expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitEnabledEvent.eventName, expect.anything());
  });

  it('never fails the committed decision when the re-enable check errors — logged, not thrown', async () => {
    db.$queryRaw.mockRejectedValue(new Error('connection reset'));

    await expect(service.decide(decision())).resolves.toMatchObject({ changed: true });
  });

  /**
   * The user-scope mirror (#225). The covering predicate is the same
   * scope-parametric method the household matrix above exercises, so these
   * assert the mirrored transition, the guarded write, and the scope's own
   * wrinkle — the decision's in-transaction row ensure never clears a
   * suspension.
   */
  describe('user scope', () => {
    const userGrant = (overrides: Partial<PluginGrant> = {}): PluginGrant =>
      makeGrant({
        id: 'grant-u1',
        scopeType: PluginGrantScope.User,
        scopeId: 'user-1',
        permissionSlug: 'read:user_digest',
        ...overrides,
      });

    const userDecision = (): PluginGrantDecisionInput =>
      decision({
        scopeType: PluginGrantScope.User,
        scopeId: 'user-1',
        deciderId: 'user-1',
        permissionSlug: 'read:user_digest',
      });

    beforeEach(() => {
      db.permission.findUnique.mockResolvedValue(corePermission('read:user_digest', RiskLevel.Low));
      db.permission.findMany.mockResolvedValue([corePermission('read:user_digest', RiskLevel.Low)]);
      db.pluginGrant.upsert.mockResolvedValue(userGrant());
      db.pluginGrant.findMany.mockResolvedValue([userGrant()]);
      db.$queryRaw.mockResolvedValue(lockedUnit('up-1', true));
      db.userPlugin.updateMany.mockResolvedValue({ count: 1 });
    });

    it('clears the suspension and emits unit_enabled when the decision covers the last outstanding required slug', async () => {
      await service.decide(userDecision());

      expect(db.userPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'up-1', suspendedForConsent: true },
        data: { suspendedForConsent: false, suspendedAt: null },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        UserPluginUnitEnabledEvent.eventName,
        expect.objectContaining({
          grantedPermissionSlug: 'read:user_digest',
          manifestVersion: '1.2.0',
          before: expect.objectContaining({ suspendedForConsent: true, userId: 'user-1' }),
          after: expect.objectContaining({ suspendedForConsent: false }),
        }),
      );
    });

    it('the in-transaction row ensure does not clear the suspension — only the late-acceptance predicate may', async () => {
      await service.decide(userDecision());

      // The ensure runs with an EMPTY update arm; the only suspension write
      // is the guarded late-acceptance clear asserted above.
      expect(db.userPlugin.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    });

    it('leaves the suspension in place while a required user slug remains outstanding', async () => {
      db.pluginGrant.findMany.mockResolvedValue([]);

      await service.decide(userDecision());

      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(UserPluginUnitEnabledEvent.eventName, expect.anything());
    });

    it('leaves the suspension in place when a granted slug no longer covers the catalog risk', async () => {
      db.pluginGrant.findMany.mockResolvedValue([userGrant({ decidedRiskLevel: RiskLevel.Low })]);
      db.permission.findMany.mockResolvedValue([corePermission('read:user_digest', RiskLevel.High)]);

      await service.decide(userDecision());

      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('does nothing for a unit that is not suspended', async () => {
      db.$queryRaw.mockResolvedValue(lockedUnit('up-1', false));

      await service.decide(userDecision());

      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('does not emit when a concurrent writer already cleared the suspension (guarded updateMany)', async () => {
      db.userPlugin.updateMany.mockResolvedValue({ count: 0 });

      await service.decide(userDecision());

      expect(emitter.emit).not.toHaveBeenCalledWith(UserPluginUnitEnabledEvent.eventName, expect.anything());
    });

    it('never fails the committed decision when the re-enable check errors — logged, not thrown', async () => {
      db.$queryRaw.mockRejectedValue(new Error('connection reset'));

      await expect(service.decide(userDecision())).resolves.toMatchObject({ changed: true });
    });
  });

  /**
   * The suspend mirror (D-BQ, #322): a changed `Denied` on a REQUIRED
   * unit-scope check of the active manifest suspends the unit — the
   * unit-scope resolution of the required-denial question, where D-AV's
   * server-scope refusal has no analogue (a unit holds no uninstall lever;
   * its honest "disabled for this unit" is the consent suspension C3
   * models). Driven by the same outstanding-slug predicate as the
   * re-enable above, so the pair cannot oscillate.
   */
  describe('denial suspension mirror (D-BQ)', () => {
    beforeEach(() => {
      db.$queryRaw.mockResolvedValue(lockedUnit('hp-1', false));
      db.pluginGrant.upsert.mockResolvedValue(makeGrant({ status: PluginGrantStatus.Denied }));
      // No Granted rows for the unit: the denied required check is
      // outstanding by construction.
      db.pluginGrant.findMany.mockResolvedValue([]);
    });

    it('suspends the unit and emits unit_disabled when a denial lands on a required household check', async () => {
      await service.decide(decision({ status: PluginGrantStatus.Denied }));

      expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'hp-1', suspendedForConsent: false },
        data: { suspendedForConsent: true, suspendedAt: expect.any(Date) },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        HouseholdPluginUnitDisabledEvent.eventName,
        expect.objectContaining({
          requiredPermissionSlugs: ['calendar:read'],
          manifestVersion: '1.2.0',
          before: expect.objectContaining({ suspendedForConsent: false, householdId: 'household-1' }),
          after: expect.objectContaining({ suspendedForConsent: true }),
        }),
      );
      // ONE transaction: the suspension commits with the denial, so a flip
      // that cannot be written takes the denial back with it (#359 round 3)
      // — the opposite posture from the re-enable direction's own-tx pass.
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    it('an OPTIONAL denial never suspends — the durable denial is preserved and features degrade per-check', async () => {
      await service.decide(decision({ permissionSlug: 'notify:send', status: PluginGrantStatus.Denied }));

      // Delta-scoped: the mirror does not even look the unit up. A unit
      // legitimately enabled while some OTHER requirement is pending is not
      // this decision's to suspend.
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
    });

    it('does not suspend when a concurrent grant undid the denial and only an unrelated slug is outstanding', async () => {
      // calendar:read — the slug this decision denied — was granted by a
      // concurrent decision before the mirror reached the unit, so this
      // denial has nothing left to suspend over. notify:send IS outstanding,
      // for a reason this decision never addressed: it is granted at a risk
      // the catalog has since raised. Asking only whether the outstanding
      // set is non-empty would suspend the unit over that unrelated debt.
      db.pluginGrant.findMany.mockResolvedValue([
        makeGrant(),
        makeGrant({ id: 'grant-2', permissionSlug: 'notify:send', decidedRiskLevel: RiskLevel.Low }),
      ]);
      db.permission.findMany.mockResolvedValue([
        corePermission('calendar:read', RiskLevel.Low),
        corePermission('notify:send', RiskLevel.High),
      ]);

      await service.decide(decision({ status: PluginGrantStatus.Denied }));

      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitDisabledEvent.eventName, expect.anything());
    });

    it('a re-stated (unchanged) denial writes no grant but still reconciles the unit', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(
        makeGrant({ status: PluginGrantStatus.Denied, decidedRiskLevel: RiskLevel.Low }),
      );

      const result = await service.decide(decision({ status: PluginGrantStatus.Denied }));

      expect(result.changed).toBe(false);
      expect(db.pluginGrant.upsert).not.toHaveBeenCalled();
      // The repair path: a denial whose suspension never landed is exactly
      // what gets re-POSTed, and the mirror is the only writer that can
      // still fix it.
      expect(db.householdPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'hp-1', suspendedForConsent: false },
        data: { suspendedForConsent: true, suspendedAt: expect.any(Date) },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        HouseholdPluginUnitDisabledEvent.eventName,
        expect.objectContaining({ requiredPermissionSlugs: ['calendar:read'] }),
      );
    });

    it('a rowless unit is untouched — nothing exists to suspend', async () => {
      db.$queryRaw.mockResolvedValue([]);

      await service.decide(decision({ status: PluginGrantStatus.Denied }));

      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitDisabledEvent.eventName, expect.anything());
    });

    it('does not emit when a concurrent writer already suspended the unit (guarded updateMany)', async () => {
      db.householdPlugin.updateMany.mockResolvedValue({ count: 0 });

      await service.decide(decision({ status: PluginGrantStatus.Denied }));

      expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitDisabledEvent.eventName, expect.anything());
    });

    /**
     * Deliberately the opposite of what this asserted before #359 round 3:
     * swallowing a suspension failure on a CHANGED denial is fail-open —
     * the denial goes durable, the caller gets a 200, and the unit keeps
     * serving with nothing in the tree that retries. Now the suspension
     * rides the decision transaction: the error takes the denial back with
     * it and no event of any kind is announced.
     */
    it('a suspension failure on a changed denial fails the whole decision — nothing commits, nothing emits', async () => {
      db.$queryRaw.mockRejectedValue(new Error('connection reset'));

      await expect(service.decide(decision({ status: PluginGrantStatus.Denied }))).rejects.toThrow('connection reset');
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('a suspension failure on a RE-STATED denial stays non-fatal — the denial is already durable and this run is the retry', async () => {
      db.pluginGrant.findUnique.mockResolvedValue(
        makeGrant({ status: PluginGrantStatus.Denied, decidedRiskLevel: RiskLevel.Low }),
      );
      db.$queryRaw.mockRejectedValue(new Error('connection reset'));

      await expect(service.decide(decision({ status: PluginGrantStatus.Denied }))).resolves.toMatchObject({
        changed: false,
      });
    });

    it('suspends the USER unit through the mirrored pass and emits the user-scope unit_disabled', async () => {
      db.permission.findUnique.mockResolvedValue(corePermission('read:user_digest', RiskLevel.Low));
      db.permission.findMany.mockResolvedValue([corePermission('read:user_digest', RiskLevel.Low)]);
      db.$queryRaw.mockResolvedValue(lockedUnit('up-1', false));
      db.userPlugin.updateMany.mockResolvedValue({ count: 1 });

      await service.decide(
        decision({
          scopeType: PluginGrantScope.User,
          scopeId: 'user-1',
          deciderId: 'user-1',
          permissionSlug: 'read:user_digest',
          status: PluginGrantStatus.Denied,
        }),
      );

      expect(db.userPlugin.updateMany).toHaveBeenCalledWith({
        where: { id: 'up-1', suspendedForConsent: false },
        data: { suspendedForConsent: true, suspendedAt: expect.any(Date) },
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        UserPluginUnitDisabledEvent.eventName,
        expect.objectContaining({
          requiredPermissionSlugs: ['read:user_digest'],
          manifestVersion: '1.2.0',
          after: expect.objectContaining({ userId: 'user-1', suspendedForConsent: true }),
        }),
      );
      // A Denied user decision creates NO enablement row (#225): the ensure
      // is the Granted arm's act alone.
      expect(db.userPlugin.upsert).not.toHaveBeenCalled();
      // Same both-or-neither transaction shape as the household sibling.
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Serialization of the two mirror directions against each other (#359
   * review). Each pass reads a predicate out of `plugin_grants` and writes
   * a conclusion to a DIFFERENT table, so without a lock the read can be
   * stale by the time the write lands: the guarded `updateMany` proves only
   * that nobody else flipped the same column, never that the premise still
   * holds. With `$queryRaw` mocked these pin the lock's presence, its
   * shape, and that it is taken BEFORE the predicate is read — not that two
   * real transactions serialize against each other, which needs a database.
   */
  describe('unit-row lock (mirror serialization)', () => {
    const capturedSql = (call: number): string => {
      const [template] = db.$queryRaw.mock.calls[call] as [TemplateStringsArray];

      return template.join('?').replace(/\s+/g, ' ');
    };

    it('reads the unit under a row lock, taken before the outstanding-slug predicate', async () => {
      await service.decide(decision());

      expect(capturedSql(0)).toContain('FOR UPDATE');
      // Decision transaction, then the mirror's own — the mirror never runs
      // inside the decision's, which would hold the grant row's lock across
      // work that can block on other units.
      expect(db.$transaction).toHaveBeenCalledTimes(2);
      // The predicate reads grants; it must do so with the unit already
      // locked, or the answer it computes is not the answer it writes.
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        db.pluginGrant.findMany.mock.invocationCallOrder[0],
      );
    });

    it('lets the predicate under the lock overrule the trigger that fired the pass (reconcile path)', async () => {
      // On a CHANGED denial this interleaving no longer exists: the flip
      // either commits first and the upsert re-denies over it, or it blocks
      // on the grant-row lock until the denial's transaction resolves. It
      // survives only on the reconcile path — a re-POSTed denial whose slug
      // a concurrent `Granted` flip has since satisfied. The trigger says
      // "suspend"; the predicate read under the lock says this slug owes
      // nothing, and it wins.
      db.pluginGrant.findUnique.mockResolvedValue(
        makeGrant({ status: PluginGrantStatus.Denied, decidedRiskLevel: RiskLevel.Low }),
      );
      db.$queryRaw.mockResolvedValue(lockedUnit('hp-1', false));
      db.pluginGrant.findMany.mockResolvedValue([makeGrant()]);

      const result = await service.decide(decision({ status: PluginGrantStatus.Denied }));

      expect(result.changed).toBe(false);
      expect(db.householdPlugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(HouseholdPluginUnitDisabledEvent.eventName, expect.anything());
    });

    /**
     * Schema pin for the lock SQL. `$queryRaw` is mocked here, so the
     * statement never executes and an `@map`/`@@map` rename on the unit
     * models would pass every other test while breaking the one transaction
     * whose whole purpose is serialization. The checked-in Prisma model
     * files are the only runtime-independent source of the mapped names
     * (Prisma exposes no runtime DMMF) — same pin as #356's grant lock.
     */
    it('locks with the mapped table and column names — pinned against the Prisma model files', async () => {
      const findSchemaDir = (): string => {
        let dir = __dirname;

        for (let depth = 0; depth < 10; depth += 1) {
          const candidate = join(dir, 'prisma', 'models');

          try {
            if (statSync(candidate).isDirectory()) {
              return candidate;
            }
          } catch {
            // Not this level; keep walking toward the workspace root.
          }

          dir = resolve(dir, '..');
        }

        throw new Error('Could not locate prisma/models by walking up from the spec directory');
      };

      const schemaDir = findSchemaDir();
      const model = (file: string): string => readFileSync(join(schemaDir, 'plugin', file), 'utf8');
      /** `@@map` name, or the model name when unmapped. */
      const table = (source: string, fallback: string): string => /@@map\("([^"]+)"\)/.exec(source)?.[1] ?? fallback;
      /** `@map` name for one field, or the field name when unmapped. */
      const column = (source: string, field: string): string => {
        const line = new RegExp(`^\\s*${field}\\b.*$`, 'm').exec(source)?.[0] ?? '';

        return /@map\("([^"]+)"\)/.exec(line)?.[1] ?? field;
      };

      const householdModel = model('household-plugin.prisma');
      const userModel = model('user-plugin.prisma');

      await service.decide(decision());
      const householdSql = capturedSql(0);

      expect(householdSql).toContain(`FROM ${table(householdModel, 'HouseholdPlugin')}`);
      expect(householdSql).toContain(
        `SELECT ${column(householdModel, 'id')}, ${column(householdModel, 'enabled')}, ` +
          `${column(householdModel, 'suspendedForConsent')}`,
      );
      expect(householdSql).toContain(`WHERE ${column(householdModel, 'householdId')} = ?`);
      expect(householdSql).toContain(`${column(householdModel, 'pluginId')} = ?`);
      expect(householdSql).toContain('FOR UPDATE');

      db.$queryRaw.mockClear();
      db.permission.findUnique.mockResolvedValue(corePermission('read:user_digest', RiskLevel.Low));
      db.permission.findMany.mockResolvedValue([corePermission('read:user_digest', RiskLevel.Low)]);
      db.pluginGrant.upsert.mockResolvedValue(
        makeGrant({ scopeType: PluginGrantScope.User, scopeId: 'user-1', permissionSlug: 'read:user_digest' }),
      );
      db.$queryRaw.mockResolvedValue(lockedUnit('up-1', true));

      await service.decide(
        decision({
          scopeType: PluginGrantScope.User,
          scopeId: 'user-1',
          deciderId: 'user-1',
          permissionSlug: 'read:user_digest',
        }),
      );
      const userSql = capturedSql(0);

      expect(userSql).toContain(`FROM ${table(userModel, 'UserPlugin')}`);
      expect(userSql).toContain(`WHERE ${column(userModel, 'userId')} = ?`);
      expect(userSql).toContain(`${column(userModel, 'pluginId')} = ?`);
      expect(userSql).toContain('FOR UPDATE');
    });
  });

  /**
   * The anchor's birth state (#359 round 3): before a `UserPlugin` row
   * exists, its ABSENCE is what keeps the unit out of service — so a
   * `Granted` decision that creates it must not create it serving when a
   * required user check already carries a durable denial. Two sequential,
   * perfectly ordinary requests hit this: deny required P while rowless
   * (correctly nothing to suspend), then grant required Q. The re-enable
   * pass cannot catch it — it keys on SUSPENDED rows, and this one is new.
   */
  describe('anchor creation over an existing required denial', () => {
    const anchorManifest = buildPluginManifest({
      scope: 'household',
      permissions: {
        declares: ['manage:digest'],
        checks: [
          ...buildPluginManifest().permissions.checks,
          {
            slug: 'read:user_digest',
            required: true,
            reason: { en: 'Reads the digest each member curated for themselves.' },
            consentScope: 'user',
          },
          {
            slug: 'read:public_content',
            required: true,
            reason: { en: 'Shows public content excerpts inside per-user digests.' },
            consentScope: 'user',
          },
          {
            slug: 'notify:send',
            required: false,
            reason: { en: 'Optional per-user notification delivery.' },
            consentScope: 'user',
          },
        ],
      },
    });

    const grantQ = (): PluginGrant =>
      makeGrant({
        id: 'grant-q',
        scopeType: PluginGrantScope.User,
        scopeId: 'user-1',
        permissionSlug: 'read:public_content',
      });

    const grantDecision = (): PluginGrantDecisionInput =>
      decision({
        scopeType: PluginGrantScope.User,
        scopeId: 'user-1',
        deciderId: 'user-1',
        permissionSlug: 'read:public_content',
      });

    beforeEach(() => {
      db.plugin.findUnique.mockResolvedValue(
        makePlugin({ manifestJson: anchorManifest as unknown as Prisma.JsonValue }),
      );
      db.permission.findUnique.mockResolvedValue(corePermission('read:public_content', RiskLevel.Low));
      db.permission.findMany.mockResolvedValue([
        corePermission('read:user_digest', RiskLevel.Low),
        corePermission('read:public_content', RiskLevel.Low),
        corePermission('notify:send', RiskLevel.Low),
      ]);
      db.pluginGrant.upsert.mockResolvedValue(grantQ());
      db.pluginGrant.findMany.mockResolvedValue([grantQ()]);
    });

    it('creates the anchor suspended when another required user check is durably denied', async () => {
      db.pluginGrant.count.mockResolvedValue(1);
      // The re-enable pass then sees the born-suspended row and holds it:
      // the denied check is still outstanding.
      db.$queryRaw.mockResolvedValue(lockedUnit('up-1', true));

      await service.decide(grantDecision());

      expect(db.userPlugin.upsert).toHaveBeenCalledWith({
        where: { userId_pluginId: { userId: 'user-1', pluginId: 'plugin-1' } },
        create: {
          userId: 'user-1',
          pluginId: 'plugin-1',
          suspendedForConsent: true,
          suspendedAt: expect.any(Date),
        },
        update: {},
      });
      // Only OTHER required user checks feed the predicate: not the slug
      // being granted, and never the optional one.
      expect(db.pluginGrant.count).toHaveBeenCalledWith({
        where: {
          pluginId: 'plugin-1',
          scopeType: PluginGrantScope.User,
          scopeId: 'user-1',
          status: PluginGrantStatus.Denied,
          permissionSlug: { in: ['read:user_digest'] },
        },
      });
      // Born suspended, not flipped: no guarded write ran and no unit
      // transition is announced — this is initial state, not a transition.
      expect(db.userPlugin.updateMany).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalledWith(UserPluginUnitEnabledEvent.eventName, expect.anything());
      expect(emitter.emit).not.toHaveBeenCalledWith(UserPluginUnitDisabledEvent.eventName, expect.anything());
    });

    it('serializes the anchor path and the denial paths on one advisory key that exists before the row', async () => {
      // The unit-row FOR UPDATE cannot order these two against each other:
      // while the anchor's INSERT is uncommitted the denial finds no row to
      // wait on, and the anchor's denied-required probe cannot see the
      // uncommitted denial — each commits believing the other absent. The
      // advisory key is the one lockable thing that exists before the row,
      // so the SAME key on both sides is the entire mechanism.
      db.permission.findUnique.mockResolvedValue(corePermission('read:user_digest', RiskLevel.Low));
      db.pluginGrant.upsert.mockResolvedValue(
        makeGrant({
          id: 'grant-p',
          scopeType: PluginGrantScope.User,
          scopeId: 'user-1',
          permissionSlug: 'read:user_digest',
          status: PluginGrantStatus.Denied,
        }),
      );
      db.pluginGrant.findMany.mockResolvedValue([]);
      db.$queryRaw.mockResolvedValue([]); // rowless: nothing for FOR UPDATE to wait on

      await service.decide(
        decision({
          scopeType: PluginGrantScope.User,
          scopeId: 'user-1',
          deciderId: 'user-1',
          permissionSlug: 'read:user_digest',
          status: PluginGrantStatus.Denied,
        }),
      );

      const denialAdvisory = db.$executeRaw.mock.calls[0] as [TemplateStringsArray, string];
      // The key derives in Postgres (hashtextextended), not from a crypto
      // API — nothing is protected by the digest, and a collision only
      // over-serializes.
      expect(denialAdvisory[0].join('?')).toContain('pg_advisory_xact_lock(hashtextextended(');
      // Taken before the (empty) unit-row lock, so the order is total.
      expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.$queryRaw.mock.invocationCallOrder[0]);

      db.permission.findUnique.mockResolvedValue(corePermission('read:public_content', RiskLevel.Low));
      db.pluginGrant.upsert.mockResolvedValue(grantQ());
      db.pluginGrant.count.mockResolvedValue(1);
      db.pluginGrant.findMany.mockResolvedValue([grantQ()]);
      db.$queryRaw.mockResolvedValue(lockedUnit('up-1', true));

      await service.decide(grantDecision());

      // Anchor path (decision tx) and its re-enable pass both took it too…
      expect(db.$executeRaw.mock.calls.length).toBe(3);
      const grantAdvisory = db.$executeRaw.mock.calls[1] as [TemplateStringsArray, string];
      expect(grantAdvisory[0].join('?')).toContain('pg_advisory_xact_lock(hashtextextended(');
      // …before the denied-required probe the lock exists to make truthful.
      expect(db.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(db.pluginGrant.count.mock.invocationCallOrder[0]);
      // Same (user, plugin) → same key, across every path that touches it.
      const keys = new Set(db.$executeRaw.mock.calls.map((call) => (call as [TemplateStringsArray, string])[1]));
      expect(keys.size).toBe(1);
      expect([...keys][0]).toBe('plugin_grant:user_unit:user-1:plugin-1');
    });

    it('creates the anchor serving when the other required check is merely pending — only an explicit refusal suspends', async () => {
      db.pluginGrant.count.mockResolvedValue(0);
      db.$queryRaw.mockResolvedValue(lockedUnit('up-1', false));

      await service.decide(grantDecision());

      expect(db.userPlugin.upsert).toHaveBeenCalledWith({
        where: { userId_pluginId: { userId: 'user-1', pluginId: 'plugin-1' } },
        create: {
          userId: 'user-1',
          pluginId: 'plugin-1',
          suspendedForConsent: false,
          suspendedAt: null,
        },
        update: {},
      });
    });
  });
});
