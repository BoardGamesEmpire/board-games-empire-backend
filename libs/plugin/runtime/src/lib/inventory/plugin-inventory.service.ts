import type { PluginUnit } from '@bge/actor-context';
import {
  DatabaseService,
  PluginCategory,
  PluginExecutionMode,
  PluginScope,
  Prisma,
  type PluginUnitDormantReason,
} from '@bge/database';
import { parsePluginArtifactSha256 } from '@boardgamesempire/plugin-contract';
import { resolveLocalizedString, type PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { PluginConsentStandingService } from '../consent/plugin-consent-standing.service';
import type { PluginConsentStanding } from '../consent/plugin-consent-standing.types';
import type { PluginProvenance } from '../events/plugin.events';
import { PluginDirectoryLayoutError } from '../loader/loader.errors';
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
  readonly skip: number;
  readonly pageSize: number;
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
  readonly version: string;
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
  readonly id: string;
  readonly slug: string;
  readonly category: PluginCategory;
  readonly scope: PluginScope;
  /**
   * Localized manifest `displayName` / `description`, or `null` when the
   * stored manifest could not be read (D-CG). Nullable rather than absent so
   * one client shape handles both, with {@link manifestUnreadable} as the
   * unambiguous discriminator.
   */
  readonly displayName: string | null;
  readonly description: string | null;
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
}

/**
 * The server viewpoint (`read:plugin`): identity plus the operational and
 * provenance picture an admin manages the install from.
 */
export interface PluginInventoryEntry extends PluginInventoryIdentity {
  /** Currently ACTIVE manifest version. */
  readonly version: string;
  /** The server-level kill switch. Unit enablement layers under it. */
  readonly enabled: boolean;
  /** Non-null only when the caller opted into tombstones (D-CH). */
  readonly uninstalledAt: Date | null;
  readonly restartRequired: boolean;
  readonly installedAt: Date;
  readonly provenance: PluginProvenance;
  readonly pendingUpdate: PluginInventoryPendingUpdate | null;
}

/**
 * A unit's own enablement state, LEFT JOINed onto the plugin, with the
 * state code and consent standing worked out when read (#1149).
 */
export interface PluginInventoryUnitState {
  /**
   * Whether a unit enablement exists at all. False is a real, common state:
   * per #225 `decide()` is the only `UserPlugin` creator, so a user who has
   * consented to nothing is unanchored on every plugin — which is why this
   * is distinct from `enabled: false`.
   */
  readonly anchored: boolean;
  readonly enabled: boolean;
  /**
   * The one code a client announces for this unit: `off`, `on`,
   * `review_pending`, `needs_configuration` or `unavailable`. It carries what
   * the household entry's `dormantReason` used to say, the review pending
   * that the stored suspension flag used to say (#1149; #1061, #1063, #1147),
   * and the server switch: a switched-on unit under a plugin a server admin
   * switched off reads `unavailable`, as does one whose stored manifest
   * cannot be read, since the ability path refuses it; `serverEnabled` and
   * `manifestUnreadable` on the entry say which of its causes applies.
   */
  readonly state: PluginUnitStateCode;
  /**
   * What this unit still owes the plugin, for the manifest's checks the unit
   * consumes. Empty for a row whose manifest cannot be read, since nothing
   * manifest-derived about it can be trusted ({@link PluginInventoryIdentity.manifestUnreadable}).
   */
  readonly consent: PluginConsentStanding;
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
 * The household entry adds nothing to the unit entry. Dormancy (#369, #370)
 * is read from the household's row and reported through `unit.state`
 * (`unavailable` for a scope orphan, `needs_configuration` for a retained
 * document the active schema no longer accepts), so the list reports the same
 * state the serving predicate uses (#1149).
 *
 * Dormant rows are listed rather than filtered out deliberately: a row that
 * exists and serves nothing is exactly what a household admin needs to see.
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
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
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
 * The user axis holds a switch and nothing else: no stored suspension (#1149,
 * which replaced #1061/#1063/#1147's flag with a read-time rule) and no
 * dormancy (#225 leaves the user axis without it).
 */
const USER_UNIT_STATE_SELECT = { enabled: true } as const satisfies Prisma.UserPluginSelect;

/** The household axis adds dormancy, written where it is decided (activation, reinstall). */
const HOUSEHOLD_UNIT_STATE_SELECT = {
  enabled: true,
  dormantReason: true,
} as const satisfies Prisma.HouseholdPluginSelect;

type IdentityRow = Prisma.PluginGetPayload<{ select: typeof IDENTITY_SELECT }>;
type ServerRow = Prisma.PluginGetPayload<{ select: typeof SERVER_SELECT }>;
type UnitRow = Prisma.PluginGetPayload<{ select: typeof UNIT_SELECT }>;
/** A user row has no `dormantReason`; the household row always has one. */
type UnitStateRow = { enabled: boolean; dormantReason?: PluginUnitDormantReason | null };

/**
 * The installed-plugin inventory (#354): the reads that answer "what is on
 * this server" before any slug is known. Every other plugin read is
 * slug-addressed, which left no way to discover a slug — the C4 endpoint
 * inventory covered every action and every per-unit read and nothing that
 * enumerates.
 *
 * Three list surfaces and one detail read, all built here rather than at the
 * edge, because the row set, the tombstone predicate, the per-row manifest
 * degradation, and the localization chain are domain rules that the three
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
 * **Ceilings (#517).** Each list takes the caller's ceiling as a required
 * function and runs the `where` it returns for both the rows and the count;
 * see {@link PluginInventoryCeiling}.
 */
@Injectable()
export class PluginInventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly standing: PluginConsentStandingService,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Every installed plugin from the server viewpoint. No unit state: unit
   * enablement and consent standing belong to a household or user, so the unit
   * variants carry them and this one does not.
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

    return { rows: rows.map((row) => this.toEntry(row, options.locale)), total };
  }

  /**
   * The household viewpoint (D-CE): every plugin the household axis admits,
   * with this household's unit enablement joined on — PLUS any plugin this
   * household already holds a row for, whatever its current scope says
   * (D-CF). Driven from the plugin table, never from `HouseholdPlugin`
   * rows, so a household that has enabled nothing still sees what it could
   * enable.
   *
   * Each row reports `unit.state` and `unit.consent` (#1149): the household's
   * switch and dormancy from its row, and the consent standing worked out from
   * the row's own manifest on this read, one classification per listed plugin.
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
      // The D-CF arm is the second one. A plain `scope: Household` filter
      // would hide exactly the rows a narrowing activation leaves behind: it
      // rewrites `scope` and marks the rows dormant (#369, D-CK) rather than
      // retiring them, so the row set has to admit a plugin this household
      // holds a row for whatever its scope says today.
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
        rows.map((row) =>
          // `@@unique([householdId, pluginId])` makes the filtered relation at
          // most one row, so the first element is the whole answer.
          this.toUnitInventoryEntry(row, row.householdPlugins[0], unit, options.locale),
        ),
      ),
      total,
    };
  }

  /**
   * The acting user's own viewpoint (D-CE). Row set is EVERY installed
   * plugin, with no scope narrowing: user-scope consent is legal at any
   * plugin scope (#225), so unlike the household axis there is no such thing
   * as a plugin whose SCOPE a user cannot be anchored under — and therefore
   * no orphan state to flag.
   *
   * There IS a narrowing this does not apply, and #381 owns it: `decide()`
   * anchors only on a Granted user-scope decision, so a plugin whose manifest
   * declares no `consentScope: 'user'` check can never hold a row for anyone
   * and is noise here. That predicate lives in `manifest_json` and is not
   * expressible as a `WHERE`, so post-filtering it would falsify the `total`
   * D-CD requires. The field-level exposure is already closed — this read
   * serves no version, provenance, install history or tombstones — so what
   * #381 weighs is the enumeration alone.
   *
   * Each row reports `unit.state` and `unit.consent` (#1149). The user axis
   * has no dormancy, so an unanchored or switched-off row reads `off` and any
   * other reads `review_pending` while a required user-scope check is owed.
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
        rows.map((row) => this.toUnitInventoryEntry(row, row.userPlugins[0], unit, options.locale)),
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
   * once per list row and shared by the localized fields and the consent
   * standing, so the two cannot disagree about whether the row is readable.
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
  private serverColumns(row: ServerRow): Omit<PluginInventoryEntry, keyof PluginInventoryIdentity> {
    return {
      version: row.version,
      enabled: row.enabled,
      uninstalledAt: row.uninstalledAt,
      restartRequired: row.restartRequired,
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

  private toEntry(row: ServerRow, locale?: string): PluginInventoryEntry {
    return {
      ...this.identityOf(row),
      ...this.serverColumns(row),
      ...this.localize(this.validatedOrNull(row), locale),
    };
  }

  /**
   * A unit list row: identity, the server switch, and nothing else from the
   * operational set — those columns are not even selected for these reads —
   * plus the unit's state and consent standing (#1149).
   *
   * The standing is resolved here, per row, from the manifest already
   * re-validated for the localized fields. A row whose manifest cannot be
   * read keeps its marker, owes nothing, since nothing manifest-derived
   * about it can be trusted, and reads `unavailable` rather than `on`: the
   * ability path refuses such a manifest, so a client announcing the code
   * alone must not hear that the unit runs (PR #1155 review). The per-row
   * classification is accepted for now; caching is deferred.
   */
  private async toUnitInventoryEntry(
    row: UnitRow,
    unitRow: UnitStateRow | undefined,
    unit: PluginUnit,
    locale?: string,
  ): Promise<PluginUnitInventoryEntry> {
    const validated = this.validatedOrNull(row);
    const consent: PluginConsentStanding =
      validated === null
        ? { outstanding: [], optionalOff: [] }
        : await this.standing.resolve(row.id, unit, validated.permissionChecks, locale);

    return {
      ...this.identityOf(row),
      serverEnabled: row.enabled,
      ...this.localize(validated, locale),
      unit: this.toUnitState(unitRow, row.enabled, validated === null, consent),
    };
  }

  /**
   * A missing unit enablement is an unanchored unit, not a disabled one. The
   * user unit enablement has no dormancy field, so its dormant reason reads
   * `null`.
   */
  private toUnitState(
    row: UnitStateRow | undefined,
    serverEnabled: boolean,
    manifestUnreadable: boolean,
    consent: PluginConsentStanding,
  ): PluginInventoryUnitState {
    const anchored = row !== undefined;
    const enabled = row?.enabled ?? false;

    return {
      anchored,
      enabled,
      state: derivePluginUnitState({
        anchored,
        enabled,
        serverEnabled,
        manifestUnreadable,
        dormantReason: row?.dormantReason ?? null,
        outstandingCount: consent.outstanding.length,
      }),
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
