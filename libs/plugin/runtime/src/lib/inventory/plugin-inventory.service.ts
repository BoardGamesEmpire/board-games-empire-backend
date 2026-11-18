import { SERVER_PLUGIN_UNIT, type PluginUnit } from '@bge/actor-context';
import {
  DatabaseService,
  derivePluginUnitDormancy,
  PluginCategory,
  PluginExecutionMode,
  PluginScope,
  Prisma,
  retainedConfigOf,
  type PluginProcessRole,
  type PluginUnitDormancy,
} from '@bge/database';
import { parsePluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { resolveLocalizedString, type PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { PluginConsentStandingService } from '../consent/plugin-consent-standing.service';
import type { PluginConsentStanding } from '../consent/plugin-consent-standing.types';
import type { PluginProvenance } from '../events/plugin.events';
import { PluginDirectoryLayoutError } from '../loader/loader.errors';
import { restartProcessRoles } from '../loader/process-role';
import { activeManifestOf } from '../manifest/active-manifest';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { derivePluginUnitState, type PluginUnitStateCode } from '../units/plugin-unit-state';
import {
  PluginInventoryManifestError,
  PluginInventoryNotFoundError,
  PluginInventoryTombstonedError,
} from './inventory.errors';

/**
 * The paging a caller resolved, as a STRUCTURAL slice rather than an import
 * of the HTTP DTO. `PaginationQueryDto` satisfies it by its `skip`/`pageSize`
 * getters, so the edge passes its query object straight through — but the
 * runtime lib stays free of `@bge/shared`, whose DTOs carry Swagger and
 * class-validator metadata that has no business in the domain layer. Same
 * posture as the runtime's transport-agnostic errors.
 */
export interface PluginInventoryPaging {
  readonly pageSize: number;
  readonly skip: number;
}

/**
 * Rows plus the count of everything matching, shaped to satisfy `@bge/shared`'s
 * `PaginatedRows<T>` structurally so the edge can hand it to `paginated()`
 * with no adapter.
 */
export interface PluginInventoryRows<T> {
  readonly rows: T[];
  readonly total: number;
}

/**
 * The caller's half of a unit list: it takes the scope the list names, ANDs the
 * caller's permission ceiling onto it, and returns the result. The API edge
 * supplies it with the scope composer, which also records that the read was
 * composed, so the envelope's guard can tell.
 *
 * The runtime cannot build the ceiling itself, because it stays off the
 * permissions lib (#409). It still names the scope, which is a domain rule
 * and not the edge's to re-derive. Taking a function rather than a finished
 * `where` keeps it that way: the edge sees the scope only to compose it, and
 * one that skips composing records nothing and the envelope fails. The list
 * runs its own scope beside what comes back, so an edge that dropped it could
 * not widen the list either.
 */
export type PluginInventoryCeiling = (scope: Prisma.PluginWhereInput) => Prisma.PluginWhereInput;

/**
 * The server list's ceiling. It takes no scope: the server list is every
 * installed plugin, so the edge composes an unscoped read and says why, and
 * the tombstone filter goes beside what it returns.
 */
export type PluginServerInventoryCeiling = () => Prisma.PluginWhereInput;

export interface PluginInventoryOptions {
  /** Requester's resolved catalog locale; falls back to the host default. */
  readonly locale?: string;
}

export interface PluginServerInventoryOptions extends PluginInventoryOptions {
  /**
   * Include tombstoned plugins (D-CH). Default false, and available on the
   * SERVER list alone.
   *
   * The unit lists answer "what can this unit participate in", and a
   * tombstoned plugin can never be participated in again — its consent is
   * purged and no enable path exists — so a flag admitting them there would
   * only hand a non-admin uninstall history with nothing behind it. The
   * single-plugin read takes no equivalent either; see
   * {@link PluginInventoryTombstonedError}.
   */
  readonly includeUninstalled?: boolean;
}

/** A staged update awaiting consent, as the list surfaces it. */
export interface PluginInventoryPendingUpdate {
  /** `pendingSince`, never `updatedAt` — the latter moves on any row touch. */
  readonly since: Date;

  /**
   * The staging approve and reject must name (#357). Reported here as well as
   * on the staged-update read because this read never parses the staged
   * manifest: a staging whose manifest no longer validates — after a BGE
   * upgrade past its range, say — can't be presented, but it can still be
   * rejected with this id.
   */
  readonly stagingId: string;

  readonly version: string;
}

/**
 * What every inventory read may show anyone who can see the plugin at all:
 * which plugin it is, what it is called, and whether it is still installed.
 *
 * The split below is a privilege boundary, not tidiness. The server list is
 * gated on a server-only column of `Plugin`, which `read:plugin` and staff
 * pass; the two unit lists are not — they read through
 * `read:plugin:installed`, which every user holds and which reaches the
 * identity columns alone, because a user reading their own consent surface
 * needs no server-admin permission. So the operational picture (provenance, install
 * time, restart-required, staged updates) belongs to
 * {@link PluginInventoryEntry} alone, and the unit shapes extend THIS type
 * rather than that one — a field added to the server entry cannot reach an
 * ungated audience by inheritance.
 */
export interface PluginInventoryIdentity {
  readonly category: PluginCategory;
  readonly description: string | null;

  /**
   * Localized manifest `displayName` / `description`, or `null` when the
   * stored manifest could not be read (D-CG). Nullable rather than absent so
   * one client shape handles both, with {@link manifestUnreadable} as the
   * unambiguous discriminator.
   */
  readonly displayName: string | null;

  readonly id: string;

  /**
   * The D-CG marker: this row's stored manifest failed re-validation, so its
   * localized fields are missing and nothing manifest-derived about it can be
   * trusted. Identity columns are still true — they come from the row, not
   * the JSON — which is what makes the row actionable (an admin can still
   * uninstall it) instead of merely broken.
   *
   * Reconciling this with #79's `loadFailed` / `loadError` vocabulary is
   * #380: a load failure is a boot-time outcome the loader recorded, while
   * this is discovered at read time by whoever read the row.
   */
  readonly manifestUnreadable: boolean;

  readonly scope: PluginScope;
  readonly slug: string;
}

/**
 * A plugin running at server scope, as signed-in server discovery names it
 * (#78): which plugin it is, its plugin category, and what it is called.
 * Narrower than {@link PluginInventoryIdentity} on purpose. Every signed-in
 * actor reads it, so it carries no row id, no scope and no unreadable marker:
 * a plugin whose stored plugin manifest cannot be read is not running for
 * anyone and is left out instead.
 */
export interface RunningServerPlugin {
  readonly category: PluginCategory;

  /** The plugin manifest's `displayName` in the requested locale, else the default locale's. */
  readonly displayName: string;

  readonly slug: string;
}

/**
 * The server viewpoint (`read:plugin`): identity plus the operational and
 * provenance picture an admin manages the install from.
 */
export interface PluginInventoryEntry extends PluginInventoryIdentity {
  /** The server-level kill switch. Unit enablement layers under it. */
  readonly enabled: boolean;

  readonly installedAt: Date;
  readonly pendingUpdate: PluginInventoryPendingUpdate | null;
  readonly provenance: PluginProvenance;

  /**
   * The process roles to restart so the server runs what it has recorded:
   * empty unless {@link restartRequired} (#1096).
   */
  readonly restartProcessRoles: readonly PluginProcessRole[];

  readonly restartRequired: boolean;

  /** Non-null only when the caller opted into tombstones (D-CH). */
  readonly uninstalledAt: Date | null;

  /** The Server unit's own standing (#1336). */
  readonly unit: PluginInventoryServerUnitState;

  /** Currently ACTIVE manifest version. */
  readonly version: string;
}

/**
 * The Server unit's own standing, worked out when read (#1336), by the rule
 * the feature-state read applies to the Server unit. It has no unit
 * enablement, so no `anchored` or `enabled`: the Server switch is its own
 * switch, reported as the entry's `enabled`, and a switched-off plugin reads
 * `off`. An uninstalled plugin, listed only on request, reads `off`, dormancy
 * `null` and owes nothing.
 */
export interface PluginInventoryServerUnitState {
  /**
   * What the server still owes the plugin for the manifest's server-scope
   * requested permissions. Empty for a row whose manifest cannot be read,
   * since nothing manifest-derived about it can be trusted.
   */
  readonly consent: PluginConsentStanding;

  /**
   * `unavailable` when the stored manifest cannot be read, `null` for every
   * other row: the dormancy rule judges no configuration for the Server unit,
   * which holds no document of its own (#697).
   */
  readonly dormancy: PluginUnitDormancy | null;

  /** `off`, `on`, `review_pending` or `unavailable`, as the feature-state read reports for the Server unit. */
  readonly state: PluginUnitStateCode;
}

/**
 * A unit's own enablement state, LEFT JOINed onto the plugin, with the
 * state code and consent standing worked out when read (#1149).
 */
export interface PluginInventoryUnitState {
  /**
   * Whether a unit enablement exists at all. False is a real, common state:
   * the unit's own switch-on, a consent act, is the only creator of its
   * enablement (#1150), so a unit that never switched a plugin on is
   * unanchored on it — which is why this is distinct from `enabled: false`.
   */
  readonly anchored: boolean;

  /**
   * What this unit still owes the plugin, for the manifest's checks the unit
   * consumes. Empty for a row whose manifest cannot be read, since nothing
   * manifest-derived about it can be trusted ({@link PluginInventoryIdentity.manifestUnreadable}).
   */
  readonly consent: PluginConsentStanding;

  /**
   * What keeps the unit from running apart from the two switches, its own
   * and the Server switch (#1151): `unavailable` when the server cannot run
   * it for this unit whatever its settings say (the stored manifest cannot be
   * read, the manifest has no surface at the unit's scope, or its config
   * schema cannot be used), `needs_configuration` when the household's
   * settings do not fit the active schema, `null` when nothing does. Worked
   * out on every read from the active manifest and the unit's document, and
   * reported whether or not the unit is switched on, so a client can say what
   * a switch-on would meet. It leaves one refusal out: a first switch-on the
   * manifest requires a document for (`requiresHouseholdConfig`) is refused
   * when it brings none, whatever the rule says about `{}`.
   */
  readonly dormancy: PluginUnitDormancy | null;

  readonly enabled: boolean;

  /**
   * The one code a client announces for this unit: `off`, `on`,
   * `review_pending`, `needs_configuration` or `unavailable`. It carries the
   * unit's dormancy, its consent standing (#1149) and the server switch: a
   * switched-on unit under a plugin a server admin switched off reads
   * `unavailable`, as does a dormant one whose `dormancy` is `unavailable`;
   * `serverEnabled` and `dormancy` say which cause applies.
   */
  readonly state: PluginUnitStateCode;
}

export interface PluginUnitInventoryEntry extends PluginInventoryIdentity {
  /**
   * The server switch, under which this unit's own enablement layers. Carried
   * because it is the operative fact for a unit's screen — enabling a unit
   * while the server has the plugin off does nothing, and without this the UI
   * can only report that silence as a mystery. Named apart from
   * `unit.enabled` so the two switches can never be misread for each other.
   */
  readonly serverEnabled: boolean;

  readonly unit: PluginInventoryUnitState;
}

/**
 * The household entry adds nothing to the unit entry. Dormancy is worked out
 * on the read from the active manifest and the household's document, and
 * reported through `unit.dormancy` and `unit.state` (`unavailable` for a
 * manifest with no household surface or an unusable config schema,
 * `needs_configuration` for a document the active schema does not accept), so
 * the list reports the same state the serving predicate uses (#1149, #1151).
 *
 * Dormant unit enablements are listed rather than filtered out deliberately:
 * one that exists and serves nothing is exactly what a household admin needs
 * to see.
 */
export type PluginHouseholdInventoryEntry = PluginUnitInventoryEntry;

/** The single-plugin read: the list entry plus what the manifest adds. */
export interface PluginInventoryDetail extends PluginInventoryEntry {
  /** Effective isolation tier — seeded from the manifest hint, admin-overridable (#197). */
  readonly executionMode: PluginExecutionMode;

  /**
   * Localized manifest features. Empty when the manifest declares none —
   * never when it could not be read, because that path throws here (D-CG).
   */
  readonly features: readonly PluginInventoryFeature[];
}

export interface PluginInventoryFeature {
  readonly description: string;
  readonly displayName: string;
  readonly name: string;
}

/**
 * Columns every inventory shape reads. `manifestJson` rides along because the
 * localized `displayName`/`description` come from it and there is no
 * projection of them on the row — one document per listed plugin, bounded by
 * the page size.
 */
const IDENTITY_SELECT = {
  id: true,
  slug: true,
  category: true,
  scope: true,
  // Needed by the manifest re-validation cross-check, never copied into a
  // unit response — `revalidateStoredManifest` compares it against the
  // manifest's own version and would be toothless without it.
  version: true,
  manifestJson: true,
} satisfies Prisma.PluginSelect;

/**
 * The server read adds the operational and provenance columns. The unit reads
 * deliberately do NOT select these: not fetching what you must not serve is
 * the half of the privilege split that survives someone widening a mapper by
 * accident.
 */
const SERVER_SELECT = {
  ...IDENTITY_SELECT,
  enabled: true,
  uninstalledAt: true,
  restartRequired: true,
  installedAt: true,
  installedFromUrl: true,
  installedSha256: true,
  registrySlug: true,
  pendingVersion: true,
  pendingSince: true,
  // Read only to decide whether an update is staged; never served.
  pendingSha256: true,
  pendingStagingId: true,
} satisfies Prisma.PluginSelect;

/** `enabled` only, surfaced as `serverEnabled` — no provenance, no staging. */
const UNIT_SELECT = { ...IDENTITY_SELECT, enabled: true } satisfies Prisma.PluginSelect;

/**
 * The user axis holds a switch and nothing else: consent standing is worked
 * out when read (#1149), and the dormancy rule never judges a user's
 * configuration (#225, #228).
 */
const USER_UNIT_STATE_SELECT = { enabled: true } as const satisfies Prisma.UserPluginSelect;

/**
 * The household axis adds its document, which the dormancy rule judges
 * against the active schema (#1151). `config` is selected for that alone and
 * never reaches a response: a household's settings belong to the config
 * routes, and {@link PluginInventoryService.toUnitInventoryEntry} builds the
 * unit state field by field so it cannot carry them.
 */
const HOUSEHOLD_UNIT_STATE_SELECT = {
  enabled: true,
  config: true,
} as const satisfies Prisma.HouseholdPluginSelect;

type IdentityRow = Prisma.PluginGetPayload<{ select: typeof IDENTITY_SELECT }>;
type ServerRow = Prisma.PluginGetPayload<{ select: typeof SERVER_SELECT }>;
type UnitRow = Prisma.PluginGetPayload<{ select: typeof UNIT_SELECT }>;
type HouseholdUnitStateRow = Prisma.HouseholdPluginGetPayload<{ select: typeof HOUSEHOLD_UNIT_STATE_SELECT }>;
type UserUnitStateRow = Prisma.UserPluginGetPayload<{ select: typeof USER_UNIT_STATE_SELECT }>;

/**
 * The installed-plugin inventory (#354): the reads that answer "what is on
 * this server" before any slug is known. Every other plugin read is
 * slug-addressed, which left no way to discover a slug — the C4 endpoint
 * inventory covered every action and every per-unit read and nothing that
 * enumerates.
 *
 * Three paged list surfaces, one detail read, and the unpaged list of plugins
 * running at server scope (#78), all built here rather than at the edge,
 * because the row set, the tombstone predicate, the per-row manifest
 * degradation, and the localization chain are domain rules that the
 * controllers must not each re-derive.
 *
 * **Paging (D-CD).** Rows and `total` share ONE `RepeatableRead`
 * transaction. Prisma's default batch isolation snapshots each statement
 * separately, so a concurrent install between them can report a total
 * smaller than the page in hand — the same hazard #230 closed for every
 * other list read. Ordering is by `slug`, which is `@unique` and therefore
 * already a total order: no tiebreaker needed for page boundaries to hold.
 *
 * **No caching.** These bodies are read immediately after the lifecycle
 * writes that change them.
 *
 * **Ceilings (#517).** Each paged list takes the actor's ceiling as a
 * required function and runs the `where` it returns for both the rows and the
 * count; see {@link PluginInventoryCeiling}. The one exception is
 * `listRunningOnServer`, which takes no ceiling by design: which plugins run on
 * the server is a fact of the server that every signed-in actor reads (#78).
 */
@Injectable()
export class PluginInventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly standing: PluginConsentStandingService,
    private readonly configSchema: PluginConfigSchemaService,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Every installed plugin from the server viewpoint. Each row reports the
   * Server unit's `unit.state`, `unit.dormancy` and `unit.consent` (#1336),
   * worked out from the row's own manifest after the page is read, as the
   * unit lists do. It carries no unit enablement: the Server switch is the
   * Server unit's own switch, and the row already reports it as `enabled`.
   */
  async listForServer(
    paging: PluginInventoryPaging,
    ceiling: PluginServerInventoryCeiling,
    options: PluginServerInventoryOptions = {},
  ): Promise<PluginInventoryRows<PluginInventoryEntry>> {
    const where: Prisma.PluginWhereInput = { AND: [ceiling(), this.tombstoneFilter(options)] };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.plugin.findMany({
          where,
          select: SERVER_SELECT,
          orderBy: { slug: 'asc' },
          skip: paging.skip,
          take: paging.pageSize,
        }),
        this.db.plugin.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: await Promise.all(rows.map((row) => this.toEntry(row, options.locale))), total };
  }

  /**
   * The plugins running at server scope, for signed-in server discovery (#78):
   * enabled, installed, not failed at load, and with a stored plugin manifest
   * that still re-validates. A plugin whose plugin manifest no longer validates
   * is left out rather than degraded, because the ability path refuses it too,
   * so it is not running; one bad row never takes out the rest of the list.
   *
   * A failed load is checked apart from the switch. The loader quarantines a
   * plugin by switching it off and marking the failure, and an admin who
   * switches it back on leaves the failure marked until a restart loads it.
   *
   * Deliberately not composed under the actor's ceiling, unlike the lists
   * above. Which plugins run on the server is a fact of the server that every
   * signed-in actor reads, an anonymous user included, and an anonymous user
   * holds no plugin read at all. What it reveals is bounded by the shape: slug,
   * plugin category and display name, no unit state and nothing operational.
   *
   * One statement with no page and no count, so there is no transaction to
   * hold two reads consistent.
   */
  async listRunningOnServer(locale?: string): Promise<RunningServerPlugin[]> {
    const rows = await this.db.plugin.findMany({
      where: { scope: PluginScope.Server, enabled: true, uninstalledAt: null, loadFailed: false },
      select: IDENTITY_SELECT,
      orderBy: { slug: 'asc' },
    });

    const resolveText = this.textResolver(locale);

    return rows.flatMap((row) => {
      const validated = this.validatedOrNull(row);

      return validated === null
        ? []
        : [{ slug: row.slug, category: row.category, displayName: resolveText(validated.manifest.displayName) }];
    });
  }

  /**
   * The household viewpoint: every plugin the household axis admits, with
   * this household's unit enablement joined on — PLUS any plugin this
   * household already holds a row for, whatever its current scope says.
   * Driven from the plugin table, never from `HouseholdPlugin`
   * rows, so a household that has enabled nothing still sees what it could
   * enable.
   *
   * Each row reports `unit.state`, `unit.dormancy` and `unit.consent` (#1149,
   * #1151): the household's switch from its unit enablement, and the dormancy
   * and consent standing worked out from the row's own manifest on this read,
   * the dormancy judging the household's document, one classification per
   * listed plugin.
   */
  async listForHousehold(
    householdId: string,
    paging: PluginInventoryPaging,
    ceiling: PluginInventoryCeiling,
    options: PluginInventoryOptions = {},
  ): Promise<PluginInventoryRows<PluginHouseholdInventoryEntry>> {
    const scope: Prisma.PluginWhereInput = {
      // Unconditional, unlike the server list: no unit read serves tombstones.
      uninstalledAt: null,
      // The second arm admits what a plain `scope: Household` filter would
      // hide: a narrowing activation rewrites the plugin's scope and retires no
      // unit enablement, so the row set has to admit a plugin this household
      // holds a unit enablement for whatever its scope says today, which then
      // reads dormant (#1151).
      OR: [{ scope: PluginScope.Household }, { householdPlugins: { some: { householdId } } }],
    };
    const where: Prisma.PluginWhereInput = { AND: [scope, ceiling(scope)] };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.plugin.findMany({
          where,
          select: {
            ...UNIT_SELECT,
            householdPlugins: { where: { householdId }, select: HOUSEHOLD_UNIT_STATE_SELECT },
          },
          orderBy: { slug: 'asc' },
          skip: paging.skip,
          take: paging.pageSize,
        }),
        this.db.plugin.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const unit: PluginUnit = { scopeType: 'Household', householdId };

    return {
      rows: await Promise.all(
        rows.map((row) => {
          // `@@unique([householdId, pluginId])` makes the filtered relation at
          // most one row, so the first element is the whole answer.
          const unitRow: HouseholdUnitStateRow | undefined = row.householdPlugins[0];

          return this.toUnitInventoryEntry(row, unitRow, unit, retainedConfigOf(unitRow), options.locale);
        }),
      ),
      total,
    };
  }

  /**
   * The acting user's own viewpoint. Row set is EVERY installed
   * plugin, with no scope narrowing: user-scope consent is legal at any
   * plugin scope (#225), so unlike the household axis there is no such thing
   * as a plugin whose SCOPE a user cannot be anchored under — and therefore
   * no orphan state to flag.
   *
   * There IS a narrowing this does not apply, and #381 owns it: a user's
   * switch-on is refused for a plugin whose active manifest requests nothing
   * at user scope (#1150), so no user can switch such a plugin on and it is
   * noise here. That predicate lives in `manifest_json` and
   * is not expressible as a `WHERE`, so post-filtering it would falsify the
   * `total` the page reports. The field-level exposure is already closed — this read
   * serves no version, provenance, install history or tombstones — so what
   * #381 weighs is the enumeration alone.
   *
   * Each row reports `unit.state`, `unit.dormancy` and `unit.consent` (#1149,
   * #1151). The dormancy rule never judges a user's configuration and admits
   * a user at any plugin scope, so a user row reads dormancy `null` unless its
   * manifest cannot be read. A row with no unit enablement, or a switched-off
   * one, reads `off`, and any other reads `review_pending` while a required
   * user-scope check is owed.
   */
  async listForUser(
    userId: string,
    paging: PluginInventoryPaging,
    ceiling: PluginInventoryCeiling,
    options: PluginInventoryOptions = {},
  ): Promise<PluginInventoryRows<PluginUnitInventoryEntry>> {
    const scope: Prisma.PluginWhereInput = { uninstalledAt: null };
    const where: Prisma.PluginWhereInput = { AND: [scope, ceiling(scope)] };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.plugin.findMany({
          where,
          select: { ...UNIT_SELECT, userPlugins: { where: { userId }, select: USER_UNIT_STATE_SELECT } },
          orderBy: { slug: 'asc' },
          skip: paging.skip,
          take: paging.pageSize,
        }),
        this.db.plugin.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const unit: PluginUnit = { scopeType: 'User', userId };

    return {
      rows: await Promise.all(
        rows.map((row) => {
          const unitRow: UserUnitStateRow | undefined = row.userPlugins[0];

          // The rule never judges a user's configuration (#228).
          return this.toUnitInventoryEntry(row, unitRow, unit, null, options.locale);
        }),
      ),
      total,
    };
  }

  /**
   * One installed plugin, addressed by slug, with the manifest detail a
   * list page has no room for.
   *
   * Order of refusals matters. The tombstone check runs BEFORE manifest
   * re-validation, so an uninstalled plugin whose stored manifest has since
   * gone stale renders 410 rather than 500 — the same ordering the
   * feature-state derivation uses, and for the same reason: a stale document
   * must not turn "uninstalled" into corrupted-server-state.
   *
   * Then, unlike the list reads, a corrupt manifest THROWS (D-CG). Degrading
   * is the right answer when one bad row would otherwise take out a page of
   * good ones; here the bad row is the entire response, and a 200 describing
   * a plugin whose manifest could not be read would be a body with nothing
   * in it worth trusting.
   */
  async getBySlug(slug: string, locale?: string): Promise<PluginInventoryDetail> {
    const row = await this.db.plugin.findUnique({
      where: { slug },
      select: { ...SERVER_SELECT, executionMode: true },
    });

    if (row === null) {
      throw new PluginInventoryNotFoundError(slug);
    }

    if (row.uninstalledAt !== null) {
      throw new PluginInventoryTombstonedError(slug, row.uninstalledAt);
    }

    const validated = revalidateStoredManifest(
      row,
      this.options,
      (pluginSlug, detail, issues) => new PluginInventoryManifestError(pluginSlug, detail, issues),
    );

    const resolveText = this.textResolver(locale);

    return {
      ...this.identityOf(row),
      ...this.serverColumns(row),
      unit: await this.serverUnitStateOf(row, validated, locale),
      displayName: resolveText(validated.manifest.displayName),
      description: resolveText(validated.manifest.description),
      manifestUnreadable: false,
      executionMode: row.executionMode,
      features: validated.manifest.features.map((feature) => ({
        name: feature.name,
        displayName: resolveText(feature.displayName),
        description: resolveText(feature.description),
      })),
    };
  }

  /**
   * Whether the plugin with this slug lies under the actor's ceiling.
   *
   * It answers for the edge's key-scope check on the routes that address one
   * plugin by slug (#789) and serves nothing. A type-level gate passes a key
   * whatever plugin its scope names, and the services behind those routes read
   * by slug alone, so without it a key scoped to one plugin reads and writes
   * every other. The edge composes the ceiling with the slug as its scope; the
   * slug also goes beside what comes back, as the lists run their scope, so a
   * ceiling that dropped it could not answer for another plugin.
   *
   * It does not tell an unknown slug from one outside the ceiling. The edge
   * answers both with the route's own not-found error, so a key cannot tell
   * which plugins are installed beyond its scope.
   */
  async existsUnderCeiling(slug: string, ceiling: PluginInventoryCeiling): Promise<boolean> {
    const scope: Prisma.PluginWhereInput = { slug };
    const row = await this.db.plugin.findFirst({ where: { AND: [scope, ceiling(scope)] }, select: { id: true } });

    return row !== null;
  }

  /** D-CH: tombstones are excluded unless the SERVER caller asks for them. */
  private tombstoneFilter({ includeUninstalled }: PluginServerInventoryOptions): Prisma.PluginWhereInput {
    return includeUninstalled === true ? {} : { uninstalledAt: null };
  }

  /**
   * The D-CG degradation, shared by every list read. A manifest that fails
   * re-validation costs its row the localized fields and nothing else — the
   * identity columns come from the row, not the JSON, so they stay true and
   * the row stays actionable.
   *
   * Tombstoned rows are localized like any other when the caller opted into
   * them: their consent is purged, but the stored manifest is retained, and a
   * name is what makes "uninstalled 3 days ago" legible.
   */
  private localize(
    validated: PluginManifestValidationResult | null,
    locale?: string,
  ): Pick<PluginInventoryIdentity, 'displayName' | 'description' | 'manifestUnreadable'> {
    if (validated === null) {
      return { displayName: null, description: null, manifestUnreadable: true };
    }

    const resolveText = this.textResolver(locale);

    return {
      displayName: resolveText(validated.manifest.displayName),
      description: resolveText(validated.manifest.description),
      manifestUnreadable: false,
    };
  }

  /**
   * The stored manifest re-validated, or `null` when it fails. Read
   * once per list row and shared by the localized fields, the dormancy and
   * the consent standing, so they cannot disagree about whether the row is
   * readable.
   */
  private validatedOrNull(row: IdentityRow): PluginManifestValidationResult | null {
    try {
      return revalidateStoredManifest(
        row,
        this.options,
        (pluginSlug, detail, issues) => new PluginInventoryManifestError(pluginSlug, detail, issues),
      );
    } catch (err) {
      if (err instanceof PluginInventoryManifestError) {
        return null;
      }

      throw err;
    }
  }

  /** The columns every viewpoint may see, without reading the manifest. */
  private identityOf(
    row: IdentityRow,
  ): Omit<PluginInventoryIdentity, 'displayName' | 'description' | 'manifestUnreadable'> {
    return { id: row.id, slug: row.slug, category: row.category, scope: row.scope };
  }

  /**
   * Where the plugin artifact came from, as read back off the row. One shape,
   * with no kind to tell apart, because every plugin is installed from an
   * artifact (#696) and the database requires its checksum.
   */
  private provenanceOf(row: ServerRow): PluginProvenance {
    const sha256 = parsePluginArtifactSha256(row.installedSha256);

    if (sha256 === null) {
      // Unreachable: the database refuses any other form
      // (plugins_installed_sha256_format, #1117), so a list read never fails
      // for one row. Kept as the backstop the brand needs: refused as the
      // resolver refuses it, never served unvouched for.
      throw new PluginDirectoryLayoutError(row.slug, 'the installed checksum is not 64 lowercase hex characters');
    }

    return { sha256, url: row.installedFromUrl, registrySlug: row.registrySlug };
  }

  /** The operational half, reachable only from the `read:plugin` surface. */
  private serverColumns(row: ServerRow): Omit<PluginInventoryEntry, keyof PluginInventoryIdentity | 'unit'> {
    return {
      version: row.version,
      enabled: row.enabled,
      uninstalledAt: row.uninstalledAt,
      restartRequired: row.restartRequired,
      restartProcessRoles: restartProcessRoles(row),
      installedAt: row.installedAt,
      provenance: this.provenanceOf(row),
      // A staged row without a checksum is no staged update, as approval and the
      // pending read treat it (#696). The database sets the five staged columns
      // together or not at all (plugins_staged_update_all_or_nothing, #357), so
      // a staged update always has its time and its staging id; testing them
      // narrows the types to say so.
      pendingUpdate:
        row.pendingVersion === null ||
        row.pendingSha256 === null ||
        row.pendingSince === null ||
        row.pendingStagingId === null
          ? null
          : { version: row.pendingVersion, since: row.pendingSince, stagingId: row.pendingStagingId },
    };
  }

  private async toEntry(row: ServerRow, locale?: string): Promise<PluginInventoryEntry> {
    const validated = this.validatedOrNull(row);

    return {
      ...this.identityOf(row),
      ...this.serverColumns(row),
      ...this.localize(validated, locale),
      unit: await this.serverUnitStateOf(row, validated, locale),
    };
  }

  /**
   * The Server unit's standing (#1336). The Server switch is the Server unit's
   * own switch, so it is both `enabled` and `serverEnabled` and a switched-off
   * plugin reads `off`, as the feature-state read reports it; the unit is
   * always anchored, since it has no unit enablement to lack. An uninstalled
   * plugin resolves nothing: its consent decisions are purged and nothing is
   * worked out for it.
   */
  private async serverUnitStateOf(
    row: ServerRow,
    validated: PluginManifestValidationResult | null,
    locale?: string,
  ): Promise<PluginInventoryServerUnitState> {
    if (row.uninstalledAt !== null) {
      return { state: 'off', dormancy: null, consent: { outstanding: [], optionalOff: [] } };
    }

    // The rule judges no configuration for the Server unit (#697).
    return this.unitStandingOf(
      row.id,
      validated,
      SERVER_PLUGIN_UNIT,
      { anchored: true, enabled: row.enabled, serverEnabled: row.enabled },
      null,
      locale,
    );
  }

  /**
   * A unit list row: identity, the server switch, and nothing else from the
   * operational set — those columns are not even selected for these reads —
   * plus the unit's state, dormancy and consent standing (#1149, #1151).
   *
   * The dormancy and the standing are worked out here, per row, from the
   * manifest already re-validated for the localized fields, so the three
   * cannot disagree about whether the row is readable. A row whose manifest
   * cannot be read keeps its marker, owes nothing, since nothing
   * manifest-derived about it can be trusted, and reads dormancy and state
   * `unavailable` rather than `on`: the ability path refuses such a manifest,
   * so a client announcing the code alone must not hear that the unit runs
   * (PR #1155 review). A config schema the server cannot use makes only its
   * own row `unavailable`; the rest of the page is unaffected. The per-row
   * classification is accepted for now; caching is deferred.
   *
   * `retainedConfig` is the document the rule judges: the household's, `{}`
   * when it has no unit enablement, and `null` for a user, whose
   * configuration the rule never judges.
   */
  private async toUnitInventoryEntry(
    row: UnitRow,
    unitRow: { readonly enabled: boolean } | undefined,
    unit: PluginUnit,
    retainedConfig: unknown,
    locale?: string,
  ): Promise<PluginUnitInventoryEntry> {
    const validated = this.validatedOrNull(row);
    // A missing unit enablement reads `anchored: false`, not a disabled unit.
    // Built field by field: the household's document is selected for the
    // dormancy rule and must never reach a response (#1151).
    const anchored = unitRow !== undefined;
    const enabled = unitRow?.enabled ?? false;
    const standing = await this.unitStandingOf(
      row.id,
      validated,
      unit,
      { anchored, enabled, serverEnabled: row.enabled },
      retainedConfig,
      locale,
    );

    return {
      ...this.identityOf(row),
      serverEnabled: row.enabled,
      ...this.localize(validated, locale),
      unit: { anchored, enabled, ...standing },
    };
  }

  /**
   * One unit's state, dormancy and consent standing, worked out from the
   * manifest the row already re-validated, for every inventory read: the
   * household and user rows and the Server unit alike (#1149, #1151, #1336).
   * A manifest that cannot be read reads dormancy `unavailable` and owes
   * nothing, since nothing manifest-derived about it can be trusted.
   */
  private async unitStandingOf(
    pluginId: string,
    validated: PluginManifestValidationResult | null,
    unit: PluginUnit,
    switches: { readonly anchored: boolean; readonly enabled: boolean; readonly serverEnabled: boolean },
    retainedConfig: unknown,
    locale?: string,
  ): Promise<Pick<PluginInventoryUnitState, 'state' | 'dormancy' | 'consent'>> {
    const dormancy = derivePluginUnitDormancy({
      scopeType: unit.scopeType,
      // The rule reads a manifest that cannot be read as `unavailable`.
      manifest: validated === null ? null : activeManifestOf(validated, this.configSchema),
      retainedConfig,
    });
    const consent: PluginConsentStanding =
      validated === null
        ? { outstanding: [], optionalOff: [] }
        : await this.standing.resolve(pluginId, unit, validated.permissionChecks, locale);

    return {
      state: derivePluginUnitState({ ...switches, dormancy, outstandingCount: consent.outstanding.length }),
      dormancy,
      consent,
    };
  }

  private textResolver(locale?: string) {
    return (value: Parameters<typeof resolveLocalizedString>[0]): string =>
      resolveLocalizedString(value, {
        locale: locale ?? this.options.defaultLocale,
        defaultLocale: this.options.defaultLocale,
      });
  }
}
