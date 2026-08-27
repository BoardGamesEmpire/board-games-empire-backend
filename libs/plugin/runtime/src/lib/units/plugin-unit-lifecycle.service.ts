import type { HouseholdPlugin, Plugin, UserPlugin } from '@bge/database';
import {
  DatabaseService,
  PluginGrantScope,
  PluginGrantStatus,
  PluginScope,
  PluginUnitDormantReason,
  Prisma,
} from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginDisabledEvent,
  HouseholdPluginEnabledEvent,
  UserPluginDisabledEvent,
  UserPluginEnabledEvent,
} from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { lockHouseholdUnitScope, lockUserUnitScope } from '../grants/unit-scope-lock';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import {
  PluginUnitAuthorityError,
  PluginUnitConfigRequiredError,
  PluginUnitManifestError,
  PluginUnitNotEnrolledError,
  PluginUnitPluginChangedError,
  PluginUnitPluginNotFoundError,
  PluginUnitPluginTombstonedError,
  PluginUnitScopeError,
} from './unit.errors';

export interface HouseholdUnitActionInput {
  readonly slug: string;
  readonly householdId: string;
  /** The acting household admin — resolved from CLS at the API edge, verified here, never taken from a request body. */
  readonly actorId: string;
}

export interface HouseholdUnitEnableInput extends HouseholdUnitActionInput {
  /**
   * Inline configuration, validated against the manifest's `config.schema`
   * and written with the enable. Mandatory in effect when the manifest
   * declares `requiresHouseholdConfig` and no retained row config satisfies
   * the active schema (#323).
   */
  readonly config?: Record<string, unknown>;
}

export interface HouseholdUnitConfigInput extends HouseholdUnitActionInput {
  readonly config: Record<string, unknown>;
}

export interface UserUnitActionInput {
  readonly slug: string;
  /** The acting user — the API edge enforces the user-actor kind; this axis is self-addressed only. */
  readonly userId: string;
}

/** The columns the pre-transaction guards need; the full row is loaded only where the manifest is (enable/config). */
type LivingPluginRef = Pick<Plugin, 'id' | 'slug' | 'scope'>;

/**
 * Identifies the manifest a caller derived its gates from, so the locked
 * re-read can detect a replacement. Two columns because `version` alone
 * cannot: a reinstall over a tombstone can replace the manifest at the SAME
 * version. `installedAt` is the decisive one — the installer is its only
 * writer — see {@link PluginUnitPluginChangedError}.
 *
 * These two columns are not exhaustive, and deliberately so. Staging refuses
 * only a version equal to the CURRENT one, so activations away from and back
 * to a version (A→B→A) are permitted; that pair restores `version` and never
 * touches `installedAt`, leaving a replaced manifest invisible here. Closing
 * it needs the manifest content itself in the comparison, or a counter no
 * writer of it can skip (#368). Not closed because reaching it takes three
 * sequential admin-consented operations inside one request's lock window,
 * whereas the single activation this guard does catch takes one.
 */
type ManifestSnapshotRef = Pick<Plugin, 'version' | 'installedAt'>;

type HouseholdEnableOutcome =
  | { readonly kind: 'unchanged'; readonly row: HouseholdPlugin }
  | { readonly kind: 'created'; readonly row: HouseholdPlugin; readonly bornSuspendedSlugs: readonly string[] }
  | { readonly kind: 'updated'; readonly before: HouseholdPlugin; readonly row: HouseholdPlugin };

/**
 * Per-unit plugin enablement (#323): the household admin's
 * enable/disable/config writes and the user's own enable/disable —
 * `enabled` is the unit's OWN switch and only theirs;
 * `suspendedForConsent` stays system state written exclusively by the
 * consent machinery, so an enable flip cannot clear a suspension and a
 * suspended unit stays suspended (the serving predicate remains
 * `enabled && !suspendedForConsent`).
 *
 * Household enable is the one creator of `HouseholdPlugin` rows, and two
 * hardenings ride that (both from the #322/PR #359 review rounds, recorded
 * on #59):
 *
 * - **Born suspended over an existing refusal**: a row created while a
 *   required household-scope check of the active manifest carries a durable
 *   `Denied` is initialized `suspendedForConsent: true`. Before the row
 *   exists, its absence is what keeps the unit unserved; creating it
 *   unsuspended would put the unit IN service beside the denial without
 *   the outstanding predicate ever running. Denied specifically — merely
 *   pending required checks never suspend (a unit working through its
 *   initial consent set is legitimately enabled), and that deliberately
 *   includes a `Granted` row whose decided risk went stale: re-consent is
 *   a pending state, so it blocks features and the update pass suspends
 *   existing rows, but it does not veto the admin's enable. Late
 *   acceptance heals the unit as usual, and the blocking slugs ride the
 *   creation event into the lifecycle table so the suspension has a
 *   durable "why".
 * - **The advisory-lock scheme**: every transaction here opens the same
 *   way — the plugin row under `FOR SHARE`, then the `(scopeId, pluginId)`
 *   advisory lock, then the unit row (`openHouseholdUnit` /
 *   `openUserUnit`), a suffix of the total order
 *   (plugin row → grant row → advisory → unit row). The row-creating path
 *   cannot be serialized without the advisory lock; the existing-row paths
 *   take it too, by rule rather than by need — see the lock helper's
 *   contract before optimizing one away.
 *
 *   The plugin row comes FIRST, and the order is not free: uninstall and
 *   activation both claim that row before touching grant rows, while
 *   `decide()` holds a grant row (its upsert) while taking this advisory
 *   lock. Taking the advisory before the plugin row therefore closed a
 *   cycle — advisory → plugin → grant → advisory — that Postgres resolves
 *   by aborting a caller (PR #363 review). Reading the plugin row shared
 *   first is what orders this transaction against both of those writers.
 *
 *   The `FOR SHARE` itself exists because uninstall's purge deletes unit
 *   rows without joining the advisory scheme: reading the plugin row
 *   shared blocks a concurrent tombstone until this transaction commits
 *   (so the purge sweeps any row it created), and a tombstone that
 *   committed first is seen and refused — without it, an enable could
 *   commit a fresh row beside a tombstone whose purge promised no such row
 *   exists. It blocks a concurrent ACTIVATION the same way, which is why
 *   the re-read also returns `scope` and `version`: activation rewrites
 *   `version`/`scope`/`manifestJson` together, so every judgment a caller
 *   already made from the pre-transaction manifest is suspect. A household
 *   row created for a plugin that just became server-scope is an artifact
 *   the manifest gate says cannot exist and nothing else cleans up; and a
 *   caller that DERIVED something from the manifest — the config schema it
 *   validated against, the required-check set the born-suspended probe
 *   consulted — refuses on a version move rather than applying a stale
 *   judgment. Activation's own suspension pass cannot cover for it: that
 *   pass runs inside the activation transaction, so a row created after it
 *   committed is invisible to it, which is the whole reason the probe
 *   exists.
 *
 * Enable/disable are idempotent: a request matching current state returns
 * it unchanged — no write, no event, and no re-litigation of the config
 * gate (a stale retained document must not 409 a unit that is already
 * enabled; the gate guards the transition INTO service, and the config
 * PATCH is where stale config heals). Config writes are last-writer-wins
 * between callers — no precondition on the DOCUMENT, matching the server
 * config PATCH — but they do carry the manifest-version precondition above,
 * because the document was judged against one specific schema. Events
 * are emitted post-commit, one per real transition; a creation with inline
 * config also emits the config event, with the row's `{}` column default
 * as the before — the write is real and its consumers must see it.
 */
@Injectable()
export class PluginUnitLifecycleService {
  private readonly logger = new Logger(PluginUnitLifecycleService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly configSchema: PluginConfigSchemaService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Enable the plugin for a household, creating the enablement row on
   * first enable (the single row creator, #323). Optional inline config is
   * validated against the active `config.schema` and written atomically
   * with the enable; when none is supplied, a retained row config must satisfy
   * the ACTIVE schema — because the manifest requires household config, or
   * because the row is dormant for config and this write would cure it — and a
   * stale retained document fails the gate with its violations.
   */
  async enableHousehold(input: HouseholdUnitEnableInput): Promise<HouseholdPlugin> {
    const initiatedAt = new Date();
    const plugin = await this.loadLiving(input.slug);
    this.assertHouseholdSurface(plugin);
    await this.assertHouseholdAdmin(input.actorId, input.householdId);

    const validated = this.revalidate(plugin);
    const schema = validated.manifest.config.schema;
    const requiresConfig = validated.manifest.config.requiresHouseholdConfig;

    if (input.config !== undefined) {
      const issues = this.configSchema.validate({
        slug: plugin.slug,
        version: plugin.version,
        schema,
        config: input.config,
      });

      if (issues.length > 0) {
        throw new PluginConfigValidationError(plugin.slug, issues);
      }
    } else {
      // The retained-config validation below runs inside the transaction;
      // compiling the schema is CPU time that must not sit inside the lock
      // window (see PluginConfigSchemaService.warm).
      //
      // Warmed for EVERY config-less enable, not just the `requiresConfig` ones:
      // the second trigger for that validation is a row already dormant for
      // config, and whether this row is one cannot be known until it is read
      // inside the transaction. Warming a schema this call turns out not to
      // validate costs one cached compile per version; discovering the need
      // inside the lock window would cost that compile inside it.
      this.configSchema.warm({ slug: plugin.slug, version: plugin.version, schema });
    }

    const outcome = await this.db.$transaction(async (tx): Promise<HouseholdEnableOutcome> => {
      const existing = await this.openHouseholdUnit(tx, plugin, input.householdId, { expected: plugin });

      // Idempotency outranks the config gate: an enable that changes
      // nothing must return the unchanged row, not re-litigate a retained
      // document that went stale under a newer schema — the gate guards
      // the transition INTO service, and this unit is already there.
      //
      // A DORMANT row is not there, whatever its switch says (#369, D-CK).
      // Dormancy is written without touching `enabled`, so such a row reads as
      // enabled while serving nothing, and short-circuiting it would make the
      // admin's obvious next move — press Enable again — a 200 that changes
      // nothing and explains nothing. Falling through puts it back through the
      // gate, which either heals the row (a retained document that satisfies
      // today's schema clears the dormancy below) or refuses with the
      // violations that say what to fix.
      if (existing !== null && existing.enabled && existing.dormantReason === null && input.config === undefined) {
        return { kind: 'unchanged', row: existing };
      }

      // Two triggers, one gate. `requiresConfig` is the manifest demanding a
      // document at all; a `NeedsConfiguration` row is one whose retained
      // document a manifest replacement already judged and rejected. The second
      // does not imply the first — a later manifest may make household config
      // optional while the row still holds the document that condemned it — and
      // clearing the dormancy below without re-judging it would put that exact
      // document back into service. So the flag cannot be the whole condition:
      // the write below is what cures a config dormancy, and it may only do that
      // on a document this gate has proven against the ACTIVE schema.
      if (
        input.config === undefined &&
        (requiresConfig || existing?.dormantReason === PluginUnitDormantReason.NeedsConfiguration)
      ) {
        this.assertRetainedConfigSatisfiesGate(plugin, schema, existing);
      }

      if (existing === null) {
        const bornSuspendedSlugs = await this.deniedRequiredHouseholdSlugs(tx, plugin, validated, input.householdId);
        const bornSuspended = bornSuspendedSlugs.length > 0;

        const created = await tx.householdPlugin.create({
          data: {
            householdId: input.householdId,
            pluginId: plugin.id,
            enabled: true,
            suspendedForConsent: bornSuspended,
            suspendedAt: bornSuspended ? initiatedAt : null,
            config: (input.config ?? {}) as Prisma.InputJsonValue,
          },
        });

        return { kind: 'created', row: created, bornSuspendedSlugs };
      }

      // The enable gate above has just proven a conforming document — supplied
      // inline or retained — so this write cures a config dormancy.
      const row = await tx.householdPlugin.update({
        where: { id: existing.id },
        data: {
          ...(existing.enabled ? {} : { enabled: true }),
          ...(input.config !== undefined ? { config: input.config as Prisma.InputJsonValue } : {}),
          ...this.configDormancyCleared(existing),
        },
      });

      return { kind: 'updated', before: existing, row };
    });

    if (outcome.kind === 'created') {
      this.emitter.emit(
        HouseholdPluginEnabledEvent.eventName,
        new HouseholdPluginEnabledEvent(
          null,
          this.householdSwitchSnapshot(outcome.row),
          initiatedAt,
          outcome.bornSuspendedSlugs,
        ),
      );

      if (input.config !== undefined) {
        // The initial document is a real config write its consumers must
        // see; the before is the `{}` column default the row was born from.
        this.emitter.emit(
          HouseholdPluginConfigUpdatedEvent.eventName,
          new HouseholdPluginConfigUpdatedEvent(
            { id: outcome.row.id, householdId: outcome.row.householdId, pluginId: outcome.row.pluginId, config: {} },
            outcome.row,
            initiatedAt,
          ),
        );
      }

      if (outcome.bornSuspendedSlugs.length > 0) {
        this.logger.warn(
          `Household '${input.householdId}' enabled plugin '${plugin.slug}' born suspended: required ` +
            `household-scope consent is durably denied (${outcome.bornSuspendedSlugs.join(', ')})`,
        );
      }
    } else if (outcome.kind === 'updated') {
      if (!outcome.before.enabled) {
        this.emitter.emit(
          HouseholdPluginEnabledEvent.eventName,
          new HouseholdPluginEnabledEvent(
            this.householdSwitchSnapshot(outcome.before),
            this.householdSwitchSnapshot(outcome.row),
            initiatedAt,
          ),
        );
      }

      if (input.config !== undefined) {
        this.emitter.emit(
          HouseholdPluginConfigUpdatedEvent.eventName,
          new HouseholdPluginConfigUpdatedEvent(outcome.before, outcome.row, initiatedAt),
        );
      }
    }

    return outcome.row;
  }

  /**
   * Disable the plugin for a household. 404 on a never-enabled household —
   * enable is the row creator.
   *
   * The one household operation that does NOT require the household surface to
   * exist (D-CL): a row left dormant by a scope narrowing (#369) is visible to
   * the household's admin, and switching it off is the only thing they could
   * sensibly want to do with it. Disabling does not clear the dormancy — the
   * two are independent, the row serves nothing either way, and a re-scope back
   * must restore the admin's own intent rather than an intent this path
   * invented.
   */
  async disableHousehold(input: HouseholdUnitActionInput): Promise<HouseholdPlugin> {
    const initiatedAt = new Date();
    const plugin = await this.loadLivingRef(input.slug);
    await this.assertHouseholdAdmin(input.actorId, input.householdId);

    const outcome = await this.db.$transaction(async (tx) => {
      const existing = await this.openHouseholdUnit(tx, plugin, input.householdId, { requireSurface: false });

      if (existing === null) {
        throw new PluginUnitNotEnrolledError(plugin.slug, 'Household');
      }

      if (!existing.enabled) {
        return { before: null, row: existing };
      }

      const row = await tx.householdPlugin.update({ where: { id: existing.id }, data: { enabled: false } });

      return { before: existing, row };
    });

    if (outcome.before !== null) {
      this.emitter.emit(
        HouseholdPluginDisabledEvent.eventName,
        new HouseholdPluginDisabledEvent(
          this.householdSwitchSnapshot(outcome.before),
          this.householdSwitchSnapshot(outcome.row),
          initiatedAt,
        ),
      );
    }

    return outcome.row;
  }

  /**
   * Replace a household's plugin configuration. Validates against the
   * ACTIVE manifest's `config.schema` — which is also what heals a stale
   * retained document: the next write is judged against today's schema,
   * no migration pass required. 404 on a never-enabled household.
   */
  async updateHouseholdConfig(input: HouseholdUnitConfigInput): Promise<HouseholdPlugin> {
    const initiatedAt = new Date();
    const plugin = await this.loadLiving(input.slug);
    this.assertHouseholdSurface(plugin);
    await this.assertHouseholdAdmin(input.actorId, input.householdId);

    const validated = this.revalidate(plugin);
    const issues = this.configSchema.validate({
      slug: plugin.slug,
      version: plugin.version,
      schema: validated.manifest.config.schema,
      config: input.config,
    });

    if (issues.length > 0) {
      throw new PluginConfigValidationError(plugin.slug, issues);
    }

    const { before, row } = await this.db.$transaction(async (tx) => {
      const existing = await this.openHouseholdUnit(tx, plugin, input.householdId, { expected: plugin });

      if (existing === null) {
        throw new PluginUnitNotEnrolledError(plugin.slug, 'Household');
      }

      const updated = await tx.householdPlugin.update({
        where: { id: existing.id },
        data: { config: input.config as Prisma.InputJsonValue, ...this.configDormancyCleared(existing) },
      });

      return { before: existing, row: updated };
    });

    this.emitter.emit(
      HouseholdPluginConfigUpdatedEvent.eventName,
      new HouseholdPluginConfigUpdatedEvent(before, row, initiatedAt),
    );

    return row;
  }

  /** Enable the user's own unit. 404 without an anchor row — decide() remains the only creator (#225). */
  async enableUser(input: UserUnitActionInput): Promise<UserPlugin> {
    return this.setUserEnabled(input, true);
  }

  /** Disable the user's own unit. 404 without an anchor row — decide() remains the only creator (#225). */
  async disableUser(input: UserUnitActionInput): Promise<UserPlugin> {
    return this.setUserEnabled(input, false);
  }

  private async setUserEnabled(input: UserUnitActionInput, enabled: boolean): Promise<UserPlugin> {
    const initiatedAt = new Date();
    const plugin = await this.loadLivingRef(input.slug);

    const outcome = await this.db.$transaction(async (tx) => {
      const existing = await this.openUserUnit(tx, plugin, input.userId);

      if (existing === null) {
        throw new PluginUnitNotEnrolledError(plugin.slug, 'User');
      }

      if (existing.enabled === enabled) {
        return { before: null, row: existing };
      }

      const row = await tx.userPlugin.update({ where: { id: existing.id }, data: { enabled } });

      return { before: existing, row };
    });

    if (outcome.before !== null) {
      const EventClass = enabled ? UserPluginEnabledEvent : UserPluginDisabledEvent;

      this.emitter.emit(
        EventClass.eventName,
        new EventClass(this.userSwitchSnapshot(outcome.before), this.userSwitchSnapshot(outcome.row), initiatedAt),
      );
    }

    return outcome.row;
  }

  /**
   * Every unit-state transaction opens the same way, fused into one helper
   * so obtaining the row WITHOUT the lock has no convenient API: the plugin
   * row's liveness under `FOR SHARE`, then the advisory lock, then the unit
   * row. See the class doc for why the plugin row must come first (a
   * deadlock cycle against uninstall/activation and `decide()`) and why the
   * share lock is load-bearing against uninstall's purge.
   *
   * The scope re-check runs on the freshly read row and reuses the same
   * predicate the pre-transaction guard used, so an activation that
   * re-scoped the plugin mid-request cannot leave a household row behind.
   * It runs BEFORE the advisory lock: a request that is going to be refused
   * has no business serializing other writers of that unit.
   *
   * `expected` is supplied by the callers that already DERIVED something
   * from the pre-transaction manifest — the config schema, the
   * required-check set — and refuses the write if the manifest moved
   * underneath it. Two independent writers can move it: activation promotes
   * a new `version`, and a reinstall over a tombstone replaces
   * `manifestJson` on the same row at any version, same one included, so
   * `installedAt` is carried too and tested first (the installer is its
   * only writer, which makes it the one decisive signal). The
   * paths that read no manifest (disable, the user toggles) pass nothing: a
   * manifest move changes nothing about flipping a switch, and refusing one
   * would be a failure invented for no reader's benefit.
   *
   * `requireSurface: false` is D-CL, and disable is its only caller. A row
   * whose plugin has been re-scoped to server is dormant, not absent (#369),
   * and it is on the household's screen with a reason attached — so refusing
   * the one operation that could act on it would leave an admin looking at a
   * unit with no lever at all. Enable and config PATCH keep refusing: they
   * would have to write a surface the scope rule says cannot exist, while
   * disable only records an intent about a row that already does.
   */
  private async openHouseholdUnit(
    tx: Prisma.TransactionClient,
    plugin: LivingPluginRef,
    householdId: string,
    options: { readonly expected?: ManifestSnapshotRef; readonly requireSurface?: boolean } = {},
  ): Promise<HouseholdPlugin | null> {
    const { scope } = await this.assertStillLiving(tx, plugin, options.expected);

    if (options.requireSurface !== false) {
      this.assertHouseholdSurface({ ...plugin, scope });
    }

    await lockHouseholdUnitScope(tx, householdId, plugin.id);

    return tx.householdPlugin.findUnique({
      where: { householdId_pluginId: { householdId, pluginId: plugin.id } },
    });
  }

  /**
   * The user-scope twin of {@link openHouseholdUnit}. No scope assertion:
   * `UserPlugin` is a real surface at every plugin scope (#225), so there
   * is no re-scoping that invalidates a user toggle.
   */
  private async openUserUnit(
    tx: Prisma.TransactionClient,
    plugin: LivingPluginRef,
    userId: string,
  ): Promise<UserPlugin | null> {
    await this.assertStillLiving(tx, plugin);
    await lockUserUnitScope(tx, userId, plugin.id);

    return tx.userPlugin.findUnique({
      where: { userId_pluginId: { userId, pluginId: plugin.id } },
    });
  }

  /**
   * The in-transaction half of the tombstone guard: the pre-transaction
   * read raced anything that committed between it and this transaction.
   * `FOR SHARE` (not `FOR UPDATE`) so concurrent unit writes for the same
   * plugin do not serialize against each other — only against a writer of
   * the plugin row itself, which is exactly the uninstall and the
   * activation this exists to order against. Returns the row's CURRENT
   * scope and version so the caller can re-run its gates against them
   * rather than against the pre-transaction snapshot. Raw SQL because
   * Prisma exposes no row-lock API; the unqualified table name resolves via
   * the per-worker `search_path`.
   */
  private async assertStillLiving(
    tx: Prisma.TransactionClient,
    plugin: LivingPluginRef,
    expected?: ManifestSnapshotRef,
  ): Promise<{ scope: PluginScope; version: string }> {
    const rows = await tx.$queryRaw<
      { uninstalled_at: Date | null; scope: PluginScope; version: string; installed_at: Date }[]
    >`SELECT uninstalled_at, scope, version, installed_at FROM plugins WHERE id = ${plugin.id} FOR SHARE`;
    const row = rows[0];

    if (row === undefined) {
      throw new PluginUnitPluginNotFoundError(plugin.slug);
    }

    if (row.uninstalled_at !== null) {
      throw new PluginUnitPluginTombstonedError(plugin.slug, row.uninstalled_at);
    }

    if (expected !== undefined) {
      // installedAt is tested FIRST because it is the unambiguous signal:
      // the installer is its only writer, so a move means a reinstall and
      // nothing else. A version move is not equally decisive — a reinstall
      // over a tombstone installs whatever version it was handed, so it can
      // move BOTH columns, and testing version first would report that
      // reinstall as an activation. The distinction is client-visible and
      // load-bearing: a reinstall purged every grant for the plugin, an
      // activation kept them.
      if (row.installed_at.getTime() !== expected.installedAt.getTime()) {
        throw new PluginUnitPluginChangedError(plugin.slug, 'reinstalled', expected.version, row.version);
      }

      if (row.version !== expected.version) {
        throw new PluginUnitPluginChangedError(plugin.slug, 'version-activated', expected.version, row.version);
      }
    }

    return { scope: row.scope, version: row.version };
  }

  /**
   * The born-suspended probe for the household row creator: the canonical
   * slugs of required household-scope checks of the ACTIVE manifest that
   * carry a durable `Denied` for this household. Runs under the advisory
   * lock, so a concurrent denial commits either before this probe (born
   * suspended, correct) or waits behind this transaction and runs its own
   * suspend pass against the row it then sees. The slugs — not just a
   * count — because they ride the creation event into the lifecycle table
   * as the suspension's durable "why", the same record every
   * consent-machinery suspension leaves.
   */
  private async deniedRequiredHouseholdSlugs(
    tx: Prisma.TransactionClient,
    plugin: LivingPluginRef,
    validated: PluginManifestValidationResult,
    householdId: string,
  ): Promise<readonly string[]> {
    const requiredSlugs = validated.permissionChecks
      .filter((check) => check.consentScope === 'household' && check.required)
      .map((check) => check.canonicalSlug);

    if (requiredSlugs.length === 0) {
      return [];
    }

    const denied = await tx.pluginGrant.findMany({
      where: {
        pluginId: plugin.id,
        scopeType: PluginGrantScope.Household,
        scopeId: householdId,
        status: PluginGrantStatus.Denied,
        permissionSlug: { in: requiredSlugs },
      },
      select: { permissionSlug: true },
    });

    return denied.map((grant) => grant.permissionSlug).sort();
  }

  /**
   * The unsupplied-config half of the enable gate: a retained row config
   * must satisfy the ACTIVE schema, or the enable is refused with the
   * retained document's violations — never silently enabled over config
   * an update or reinstall left stale.
   */
  private assertRetainedConfigSatisfiesGate(
    plugin: Pick<Plugin, 'slug' | 'version'>,
    schema: Record<string, unknown>,
    existing: HouseholdPlugin | null,
  ): void {
    if (existing === null) {
      throw new PluginUnitConfigRequiredError(plugin.slug, []);
    }

    const issues = this.configSchema.validate({
      slug: plugin.slug,
      version: plugin.version,
      schema,
      config: existing.config as Record<string, unknown>,
    });

    if (issues.length > 0) {
      throw new PluginUnitConfigRequiredError(plugin.slug, issues);
    }
  }

  /**
   * The dormancy half of a household write that has just validated a document
   * against the ACTIVE schema: the document that made the row dormant is gone,
   * so the dormancy is over (#370, D-CK).
   *
   * Narrowed to `NeedsConfiguration` — the only reason a config write can cure.
   * A `ScopeOrphaned` row never reaches either caller anyway (both require the
   * household surface), and clearing it here would put a row back into service
   * on a scope that has no household axis.
   */
  private configDormancyCleared(
    existing: HouseholdPlugin,
  ): Pick<Prisma.HouseholdPluginUpdateInput, 'dormantReason' | 'dormantAt'> {
    return existing.dormantReason === PluginUnitDormantReason.NeedsConfiguration
      ? { dormantReason: null, dormantAt: null }
      : {};
  }

  private async assertHouseholdAdmin(actorId: string, householdId: string): Promise<void> {
    if (!(await this.authority.isHouseholdAdmin(actorId, householdId))) {
      throw new PluginUnitAuthorityError(actorId);
    }
  }

  /** A server-scope plugin has no per-household enablement surface (the manifest gate's rule, enforced at the writer too). */
  private assertHouseholdSurface(plugin: LivingPluginRef): void {
    if (plugin.scope !== PluginScope.Household) {
      throw new PluginUnitScopeError(plugin.slug, plugin.scope.toLowerCase());
    }
  }

  /** Loads the full row for a living (non-tombstoned) plugin — the paths that read the manifest need it. */
  private async loadLiving(slug: string): Promise<Plugin> {
    const plugin = await this.db.plugin.findUnique({ where: { slug } });

    if (plugin === null) {
      throw new PluginUnitPluginNotFoundError(slug);
    }

    if (plugin.uninstalledAt !== null) {
      throw new PluginUnitPluginTombstonedError(plugin.slug, plugin.uninstalledAt);
    }

    return plugin;
  }

  /**
   * The narrow variant for paths that never read the manifest (disable,
   * the user toggles): fetching `manifestJson`/`pendingManifestJson` there
   * is tens of KB of JSON per toggle for nothing.
   */
  private async loadLivingRef(slug: string): Promise<LivingPluginRef> {
    const plugin = await this.db.plugin.findUnique({
      where: { slug },
      select: { id: true, slug: true, scope: true, uninstalledAt: true },
    });

    if (plugin === null) {
      throw new PluginUnitPluginNotFoundError(slug);
    }

    if (plugin.uninstalledAt !== null) {
      throw new PluginUnitPluginTombstonedError(plugin.slug, plugin.uninstalledAt);
    }

    return { id: plugin.id, slug: plugin.slug, scope: plugin.scope };
  }

  private revalidate(plugin: Plugin): PluginManifestValidationResult {
    return revalidateStoredManifest(
      plugin,
      this.options,
      (pluginSlug, detail, issues) => new PluginUnitManifestError(pluginSlug, detail, issues),
    );
  }

  private householdSwitchSnapshot(row: HouseholdPlugin) {
    return {
      id: row.id,
      householdId: row.householdId,
      pluginId: row.pluginId,
      enabled: row.enabled,
      suspendedForConsent: row.suspendedForConsent,
    };
  }

  private userSwitchSnapshot(row: UserPlugin) {
    return {
      id: row.id,
      userId: row.userId,
      pluginId: row.pluginId,
      enabled: row.enabled,
      suspendedForConsent: row.suspendedForConsent,
    };
  }
}
