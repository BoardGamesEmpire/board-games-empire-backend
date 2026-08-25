import { DatabaseService, PluginCategory, PluginExecutionMode, PluginScope, Prisma } from '@bge/database';
import { resolveLocalizedString, type PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
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

/**
 * Where the installed artifact came from — D-AG's typed provenance as read
 * back off the row, rather than the eleven-nullable-columns shape the table
 * stores. `bundled` carries no artifact fields at all, which is the
 * invariant (`bundled ⇒ no tarball`) made visible instead of implied by
 * nulls.
 *
 * `sha256` stays nullable on the `installed` arm even though the installer
 * enforces `bundled = false ⇒ installedSha256 IS NOT NULL`: this type
 * describes what a read found, and asserting the invariant here would turn
 * corrupt state into a non-null lie rather than something a screen can show.
 */
export type PluginInventoryProvenance =
  | { readonly kind: 'bundled' }
  | {
      readonly kind: 'installed';
      readonly sha256: string | null;
      readonly url: string | null;
      readonly registrySlug: string | null;
    };

/** A staged update awaiting consent, as the list surfaces it. */
export interface PluginInventoryPendingUpdate {
  readonly version: string;
  /** `pendingSince`, never `updatedAt` — the latter moves on any row touch. */
  readonly since: Date | null;
}

/**
 * What every inventory read may show anyone who can see the plugin at all:
 * which plugin it is, what it is called, and whether it is still installed.
 *
 * The split below is a privilege boundary, not tidiness. The server list is
 * gated on `read:plugin`; the two unit lists are not — the household axis
 * gates on household membership and the user axis only on the actor being a
 * session user, because a user reading their own consent surface needs no
 * server-admin permission. So the operational picture (provenance, install
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
  readonly provenance: PluginInventoryProvenance;
  readonly pendingUpdate: PluginInventoryPendingUpdate | null;
}

/** A unit's own enablement state, LEFT JOINed onto the plugin (D-CE). */
export interface PluginInventoryUnitState {
  /**
   * Whether an enablement row exists at all. False is a real, common state:
   * per #225 `decide()` is the only `UserPlugin` creator, so a user who has
   * consented to nothing is unanchored on every plugin — which is why this
   * is distinct from `enabled: false`.
   */
  readonly anchored: boolean;
  readonly enabled: boolean;
  readonly suspendedForConsent: boolean;
  readonly suspendedAt: Date | null;
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

export interface PluginHouseholdInventoryEntry extends PluginUnitInventoryEntry {
  /**
   * D-CF: this household holds an enablement row for a plugin whose CURRENT
   * scope has no household axis. Activation writes `scope` from the new
   * manifest and reconciles no unit rows (#369, D-CB), so a
   * household→server narrowing leaves rows like this behind — enabled, and
   * serving nothing.
   *
   * Listed rather than filtered out deliberately. While #369 is unresolved
   * these rows are invisible outside the database, and an enabled row that
   * serves nothing is exactly what an admin needs to see; a read that hides
   * one costs a support ticket, where showing a soon-to-be-retired row costs
   * a glance.
   */
  readonly scopeOrphaned: boolean;
}

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
  bundled: true,
  restartRequired: true,
  installedAt: true,
  installedFromUrl: true,
  installedSha256: true,
  registrySlug: true,
  pendingVersion: true,
  pendingSince: true,
} satisfies Prisma.PluginSelect;

/** `enabled` only, surfaced as `serverEnabled` — no provenance, no staging. */
const UNIT_SELECT = { ...IDENTITY_SELECT, enabled: true } satisfies Prisma.PluginSelect;

const UNIT_STATE_SELECT = { enabled: true, suspendedForConsent: true, suspendedAt: true } as const;

type IdentityRow = Prisma.PluginGetPayload<{ select: typeof IDENTITY_SELECT }>;
type ServerRow = Prisma.PluginGetPayload<{ select: typeof SERVER_SELECT }>;
type UnitRow = Prisma.PluginGetPayload<{ select: typeof UNIT_SELECT }>;
type UnitStateRow = { enabled: boolean; suspendedForConsent: boolean; suspendedAt: Date | null };

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
 * **No caching.** These bodies are localized (#358's cache key omits the
 * resolved locale) and they are read immediately after the lifecycle writes
 * that change them.
 */
@Injectable()
export class PluginInventoryService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Every installed plugin from the server viewpoint. No unit state: the
   * `suspendedForConsent` column lives on `HouseholdPlugin`/`UserPlugin`, so
   * there is no such fact to report here — the unit variants carry it.
   */
  async listForServer(
    paging: PluginInventoryPaging,
    options: PluginServerInventoryOptions = {},
  ): Promise<PluginInventoryRows<PluginInventoryEntry>> {
    const where = this.tombstoneFilter(options);

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
   * with this household's enablement row joined on — PLUS any plugin this
   * household already holds a row for, whatever its current scope says
   * (D-CF). Driven from the plugin table, never from `HouseholdPlugin`
   * rows, so a household that has enabled nothing still sees what it could
   * enable.
   */
  async listForHousehold(
    householdId: string,
    paging: PluginInventoryPaging,
    options: PluginInventoryOptions = {},
  ): Promise<PluginInventoryRows<PluginHouseholdInventoryEntry>> {
    const where: Prisma.PluginWhereInput = {
      // Unconditional, unlike the server list: no unit read serves tombstones.
      uninstalledAt: null,
      // The D-CF arm is the second one. A plain `scope: Household` filter
      // would hide exactly the rows #369 leaves behind, since a narrowing
      // activation rewrites `scope` without retiring them.
      OR: [{ scope: PluginScope.Household }, { householdPlugins: { some: { householdId } } }],
    };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.plugin.findMany({
          where,
          select: {
            ...UNIT_SELECT,
            householdPlugins: { where: { householdId }, select: UNIT_STATE_SELECT },
          },
          orderBy: { slug: 'asc' },
          skip: paging.skip,
          take: paging.pageSize,
        }),
        this.db.plugin.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      rows: rows.map((row) => {
        // `@@unique([householdId, pluginId])` makes the filtered relation at
        // most one row, so the first element is the whole answer.
        const unit = this.toUnitState(row.householdPlugins[0]);

        return {
          ...this.toUnitEntry(row, options.locale),
          unit,
          scopeOrphaned: row.scope === PluginScope.Server && unit.anchored,
        };
      }),
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
   */
  async listForUser(
    userId: string,
    paging: PluginInventoryPaging,
    options: PluginInventoryOptions = {},
  ): Promise<PluginInventoryRows<PluginUnitInventoryEntry>> {
    const where: Prisma.PluginWhereInput = { uninstalledAt: null };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.plugin.findMany({
          where,
          select: { ...UNIT_SELECT, userPlugins: { where: { userId }, select: UNIT_STATE_SELECT } },
          orderBy: { slug: 'asc' },
          skip: paging.skip,
          take: paging.pageSize,
        }),
        this.db.plugin.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      rows: rows.map((row) => ({
        ...this.toUnitEntry(row, options.locale),
        unit: this.toUnitState(row.userPlugins[0]),
      })),
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
    row: IdentityRow,
    locale?: string,
  ): Pick<PluginInventoryIdentity, 'displayName' | 'description' | 'manifestUnreadable'> {
    let validated: PluginManifestValidationResult;

    try {
      validated = revalidateStoredManifest(
        row,
        this.options,
        (pluginSlug, detail, issues) => new PluginInventoryManifestError(pluginSlug, detail, issues),
      );
    } catch (err) {
      if (err instanceof PluginInventoryManifestError) {
        return { displayName: null, description: null, manifestUnreadable: true };
      }

      throw err;
    }

    const resolveText = this.textResolver(locale);

    return {
      displayName: resolveText(validated.manifest.displayName),
      description: resolveText(validated.manifest.description),
      manifestUnreadable: false,
    };
  }

  /** The columns every viewpoint may see, without reading the manifest. */
  private identityOf(
    row: IdentityRow,
  ): Omit<PluginInventoryIdentity, 'displayName' | 'description' | 'manifestUnreadable'> {
    return { id: row.id, slug: row.slug, category: row.category, scope: row.scope };
  }

  /** The operational half, reachable only from the `read:plugin` surface. */
  private serverColumns(row: ServerRow): Omit<PluginInventoryEntry, keyof PluginInventoryIdentity> {
    return {
      version: row.version,
      enabled: row.enabled,
      uninstalledAt: row.uninstalledAt,
      restartRequired: row.restartRequired,
      installedAt: row.installedAt,
      provenance: row.bundled
        ? { kind: 'bundled' }
        : {
            kind: 'installed',
            sha256: row.installedSha256,
            url: row.installedFromUrl,
            registrySlug: row.registrySlug,
          },
      pendingUpdate: row.pendingVersion === null ? null : { version: row.pendingVersion, since: row.pendingSince },
    };
  }

  private toEntry(row: ServerRow, locale?: string): PluginInventoryEntry {
    return { ...this.identityOf(row), ...this.serverColumns(row), ...this.localize(row, locale) };
  }

  /**
   * A unit row: identity, the server switch, and nothing else from the
   * operational set — those columns are not even selected for these reads.
   */
  private toUnitEntry(row: UnitRow, locale?: string): Omit<PluginUnitInventoryEntry, 'unit'> {
    return { ...this.identityOf(row), serverEnabled: row.enabled, ...this.localize(row, locale) };
  }

  /** A missing enablement row is an unanchored unit, not a disabled one. */
  private toUnitState(row: UnitStateRow | undefined): PluginInventoryUnitState {
    if (row === undefined) {
      return { anchored: false, enabled: false, suspendedForConsent: false, suspendedAt: null };
    }

    return {
      anchored: true,
      enabled: row.enabled,
      suspendedForConsent: row.suspendedForConsent,
      suspendedAt: row.suspendedAt,
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
