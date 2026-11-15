import type { HouseholdPlugin, Plugin, PluginScope, UserPlugin } from '@bge/database';
import { DatabaseService, lockLiveHousehold, Prisma } from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { householdSwitchSnapshot, userSwitchSnapshot } from '../events/plugin-event-snapshots';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginDisabledEvent,
  UserPluginDisabledEvent,
} from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { lockHouseholdUnitScope, lockUserUnitScope } from '../grants/unit-scope-lock';
import {
  bindManifest,
  classifyManifestMove,
  type ClaimedPluginRow,
  type ManifestSnapshot,
} from '../manifest/manifest-move';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { assertHouseholdAdmin } from './household-admin-assertion';
import { configDormancyCleared } from './household-config-gate';
import { assertHouseholdSurface, loadLivingPlugin } from './living-plugin';
import {
  PluginUnitHouseholdNotFoundError,
  PluginUnitManifestError,
  PluginUnitNotEnrolledError,
  PluginUnitPluginChangedError,
  PluginUnitPluginNotFoundError,
  PluginUnitPluginTombstonedError,
} from './unit.errors';

export interface HouseholdUnitActionInput {
  readonly slug: string;
  readonly householdId: string;
  /** The acting household admin — resolved from CLS at the API edge, verified here, never taken from a request body. */
  readonly actorId: string;
}

export interface HouseholdUnitConfigInput extends HouseholdUnitActionInput {
  readonly config: Record<string, unknown>;
}

export interface UserUnitActionInput {
  readonly slug: string;
  /** The acting user — the API edge enforces the user-actor kind; this axis is self-addressed only. */
  readonly userId: string;
}

/** The columns the pre-transaction guards need; the full row is loaded only where the manifest is (config). */
type LivingPluginRef = Pick<Plugin, 'id' | 'slug' | 'scope'>;

/**
 * Per-unit plugin enablement (#323): the household admin's switch-off and
 * config writes, and the user's own switch-off — `enabled` is the unit's
 * OWN switch and only theirs. Consent standing is not stored on the row: it
 * is derived at read time from the grants (#1149), so no write here reads or
 * sets it.
 *
 * Switching a unit on is a consent act, and lives in
 * `PluginConsentActService` (#1150): it is the only creator of both unit
 * enablements, so every path here addresses a row that already exists and
 * refuses a unit that has none. One hardening rides these writes (from the
 * #322/PR #359 review rounds, recorded on #59):
 *
 * - **The advisory-lock scheme**: every transaction here opens the same
 *   way — the plugin row under `FOR SHARE`, then the `(scopeId, pluginId)`
 *   advisory lock, then the unit row (`openHouseholdUnit` /
 *   `openUserUnit`), a suffix of the total order
 *   (household row → plugin row → grant row → advisory → unit row). A
 *   household transaction takes the household row's share lock ahead of
 *   all of it (#548), so a soft-deleted household refuses the write. The
 *   row-creating path, the consent act, cannot be serialized without the
 *   advisory lock; the existing-row paths here take it too, by rule rather
 *   than by need — see the lock helper's contract before optimizing one away.
 *
 *   The plugin row comes before the advisory lock, and the order is not
 *   free: uninstall and activation both claim that row before touching
 *   grant rows, while a consent act holds grant rows (its upserts) while
 *   taking this advisory lock. Taking the advisory before the plugin row
 *   therefore closed a cycle — advisory → plugin → grant → advisory — that
 *   Postgres resolves by aborting a caller (PR #363 review). Reading the
 *   plugin row shared before the advisory is what orders this transaction
 *   against both of those writers.
 *
 *   The `FOR SHARE` itself exists because uninstall's purge deletes unit
 *   rows without joining the advisory scheme: reading the plugin row
 *   shared blocks a concurrent tombstone until this transaction commits
 *   (so the purge sweeps the row it wrote), and a tombstone that committed
 *   first is seen and refused — without it, a write here could commit
 *   against a plugin whose purge had already promised its unit
 *   enablements gone.
 *   It blocks a concurrent ACTIVATION the same way, which is why the
 *   re-read also returns `scope` and `version`: activation rewrites
 *   `version`/`scope`/`manifestJson` together, so every judgment a caller
 *   already made from the pre-transaction manifest is suspect. A household
 *   config written for a plugin that just became server-scope lands on a
 *   surface the manifest gate says cannot exist; and a caller that DERIVED
 *   something from the manifest — the config schema it validated against —
 *   refuses when the manifest CONTENT moved rather than applying a stale
 *   judgment (#368). A version move is one way that happens, not the test:
 *   an A→B→A activation pair replaces the content and returns the version
 *   to where the caller found it.
 *
 * Switch-off is idempotent: a request matching current state returns it
 * unchanged — no write, no event. Config writes are last-writer-wins
 * between callers — no precondition on the DOCUMENT, matching the server
 * config PATCH — but they do carry the manifest precondition above, because
 * the document was judged against one specific schema. Events are emitted
 * post-commit, one per real transition.
 */
@Injectable()
export class PluginUnitLifecycleService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly configSchema: PluginConfigSchemaService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Disable the plugin for a household. 404 on a never-enabled household —
   * the household's switch-on, a consent act, is the row creator (#1150).
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
    await assertHouseholdAdmin(this.authority, input.actorId, input.householdId);

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
          householdSwitchSnapshot(outcome.before),
          householdSwitchSnapshot(outcome.row),
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
    const plugin = await loadLivingPlugin(this.db, input.slug);
    assertHouseholdSurface(plugin.slug, plugin.scope);
    await assertHouseholdAdmin(this.authority, input.actorId, input.householdId);

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
        data: { config: input.config as Prisma.InputJsonValue, ...configDormancyCleared(existing) },
      });

      return { before: existing, row: updated };
    });

    this.emitter.emit(
      HouseholdPluginConfigUpdatedEvent.eventName,
      new HouseholdPluginConfigUpdatedEvent(before, row, initiatedAt),
    );

    return row;
  }

  /**
   * Switch off the user's own unit. 404 without a unit enablement — the
   * user's switch-on, a consent act, is its only creator (#1150). Already
   * off: no write, no event.
   */
  async disableUser(input: UserUnitActionInput): Promise<UserPlugin> {
    const initiatedAt = new Date();
    const plugin = await this.loadLivingRef(input.slug);

    const outcome = await this.db.$transaction(async (tx) => {
      const existing = await this.openUserUnit(tx, plugin, input.userId);

      if (existing === null) {
        throw new PluginUnitNotEnrolledError(plugin.slug, 'User');
      }

      if (!existing.enabled) {
        return { before: null, row: existing };
      }

      const row = await tx.userPlugin.update({ where: { id: existing.id }, data: { enabled: false } });

      return { before: existing, row };
    });

    if (outcome.before !== null) {
      this.emitter.emit(
        UserPluginDisabledEvent.eventName,
        new UserPluginDisabledEvent(userSwitchSnapshot(outcome.before), userSwitchSnapshot(outcome.row), initiatedAt),
      );
    }

    return outcome.row;
  }

  /**
   * Every unit-state transaction opens the same way, fused into one helper
   * so obtaining the row WITHOUT the lock has no convenient API: the
   * household row's liveness under `FOR SHARE` (#548), then the plugin row's,
   * then the advisory lock, then the unit row. See the class doc for why the
   * plugin row must precede the advisory lock (a deadlock cycle against
   * uninstall/activation and a consent act) and why its share lock is
   * load-bearing against uninstall's purge.
   *
   * The scope re-check runs on the freshly read row and reuses the same
   * predicate the pre-transaction guard used, so an activation that
   * re-scoped the plugin mid-request cannot leave household config behind.
   * It runs BEFORE the advisory lock: a request that is going to be refused
   * has no business serializing other writers of that unit.
   *
   * `expected` is supplied by the caller that already DERIVED something
   * from the pre-transaction manifest — the config schema — and refuses the
   * write if the manifest moved underneath it. The move is detected by
   * comparing the manifest CONTENT under the lock (#368); `version` and
   * `installedAt` ride along to say WHICH writer moved it, since the two
   * differ in whether the client's consent starts again from zero. The paths
   * that read no manifest (the switch-offs) pass nothing: a manifest move
   * changes nothing about flipping a switch, and refusing one would be a
   * failure invented for no reader's benefit.
   *
   * `requireSurface: false` exists for disable, its only caller. A row
   * whose plugin has been re-scoped to server is dormant, not absent (#369),
   * and it is on the household's screen with a reason attached — so refusing
   * the one operation that could act on it would leave an admin looking at a
   * unit with no lever at all. Config PATCH keeps refusing: it would have to
   * write a surface the scope rule says cannot exist, while disable only
   * records an intent about a row that already does.
   */
  private async openHouseholdUnit(
    tx: Prisma.TransactionClient,
    plugin: LivingPluginRef,
    householdId: string,
    options: { readonly expected?: ManifestSnapshot; readonly requireSurface?: boolean } = {},
  ): Promise<HouseholdPlugin | null> {
    // The household row, shared, before anything else (#548). The admin check
    // ran before the transaction and took no lock, so a soft-delete can commit
    // in between: this waits out one in flight and refuses one that committed.
    // First because a soft-delete holds the row while it runs and touches no
    // plugin table, so a unit write can queue behind it but never close a cycle
    // with it.
    if (!(await lockLiveHousehold(tx, householdId))) {
      throw new PluginUnitHouseholdNotFoundError(householdId);
    }

    const { scope } = await this.assertStillLiving(tx, plugin, options.expected);

    if (options.requireSurface !== false) {
      assertHouseholdSurface(plugin.slug, scope);
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
   *
   * The manifest comparison rides this same statement rather than a second
   * read: it must observe the row this lock froze, and a follow-up SELECT
   * would be a second observation of a value that had already stopped
   * moving — one more round trip for no additional truth.
   */
  private async assertStillLiving(
    tx: Prisma.TransactionClient,
    plugin: LivingPluginRef,
    expected?: ManifestSnapshot,
  ): Promise<{ scope: PluginScope; version: string }> {
    // Bound as text and cast, so the comparison is `jsonb = jsonb` and runs on
    // the same read that takes the lock (see bindManifest for the round-trip
    // caveat). NULL for the callers that pass no snapshot — the comparison
    // then yields NULL, which the guard never consults.
    const expectedManifest = expected === undefined ? null : bindManifest(expected.manifestJson);
    const rows = await tx.$queryRaw<
      (ClaimedPluginRow & { scope: PluginScope })[]
    >`SELECT uninstalled_at, scope, version, installed_at, manifest_json = ${expectedManifest}::jsonb AS manifest_matches
        FROM plugins WHERE id = ${plugin.id} FOR SHARE`;
    const row = rows[0];

    if (row === undefined) {
      throw new PluginUnitPluginNotFoundError(plugin.slug);
    }

    if (row.uninstalled_at !== null) {
      throw new PluginUnitPluginTombstonedError(plugin.slug, row.uninstalled_at);
    }

    if (expected !== undefined) {
      const kind = classifyManifestMove(row, expected);

      if (kind !== null) {
        throw new PluginUnitPluginChangedError(plugin.slug, kind, expected.version, row.version);
      }
    }

    return { scope: row.scope, version: row.version };
  }

  /**
   * The narrow variant of `loadLivingPlugin`, for paths that never read the
   * manifest (disable, the user's switch-off): fetching `manifestJson` and
   * `pendingManifestJson` there is tens of KB of JSON per switch for nothing.
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
}
