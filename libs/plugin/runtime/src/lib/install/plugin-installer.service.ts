import {
  DatabaseService,
  PluginGrantScope,
  PluginGrantStatus,
  Prisma,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
  type Permission,
  type Plugin,
  type PluginGrant,
  type PluginPermission,
} from '@bge/database';
import type { InstalledPluginDirectory } from '@boardgamesempire/plugin-contract';
import {
  PluginManifestValidationError,
  resolveLocalizedString,
  validatePluginManifest,
  type ManifestWarning,
  type NormalizedPermissionRequest,
  type PluginManifestValidationResult,
} from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { readFile } from 'node:fs/promises';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { PluginInstalledEvent, type GrantedPermissionRecord, type PluginProvenance } from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { MANIFEST_CATEGORY_TO_PRISMA } from '../registry/plugin-category.map';
import {
  emitHouseholdDormancy,
  reconcileHouseholdDormancy,
  type HouseholdDormancyTransition,
} from '../units/household-dormancy';
import { CLEARED_STAGED_UPDATE } from '../update/staged-update.columns';
import {
  collectForbiddenPermissionViolations,
  collectUnboundedUnitConsentViolations,
  collectWildcardSubjectViolations,
  compareExactReentry,
  criticalConfirmationExpectation,
  resolveForbiddenSpecifierAcknowledgement,
} from './consent-gates';
import {
  PluginInstallAuthorityError,
  PluginInstallConflictError,
  PluginInstallCriticalConfirmationError,
  PluginInstallForbiddenPermissionError,
  PluginInstallManifestError,
  PluginInstallPermissionCollisionError,
  PluginInstallProvenanceMismatchError,
  PluginInstallStaticAnalysisError,
  PluginInstallUnknownCorePermissionError,
} from './install.errors';
import {
  DEFAULT_PLUGIN_EXECUTION_MODE,
  MANIFEST_EXECUTION_MODE_TO_PRISMA,
  MANIFEST_SCOPE_TO_PRISMA,
} from './manifest-enum.maps';
import { PluginStaticAnalysisService } from './plugin-static-analysis.service';
import { gatingFindings, type StaticAnalysisFinding, type StaticAnalysisReport } from './static-analysis.types';

/**
 * Typed provenance: `bundled = false ⇒ installedSha256` is
 * unrepresentable-when-violated rather than a runtime throw — the compile-
 * time analog of the `bundled = false ⇒ installed_sha256 IS NOT NULL`
 * pipeline invariant, consistent with the `PermissionSeedDefinition`
 * precedent.
 */
export type PluginInstallProvenance =
  | { readonly bundled: true }
  | {
      readonly bundled: false;
      readonly installedSha256: string;
      /** Absent for manual uploads (checksum without a source URL). */
      readonly installedFromUrl?: string;
      /** `PluginRegistrySource.slug` the artifact was discovered through (#84). */
      readonly registrySlug?: string;
    };

export interface PluginInstallInput {
  /** Populated by the #84 pipeline (or the bundled resolver) — the installer never touches a tarball (#59). */
  readonly directory: InstalledPluginDirectory;
  readonly provenance: PluginInstallProvenance;
  /** The installing admin — server-admin authority is verified, never assumed. */
  readonly installerId: string;
  /** Exact re-entry of every Critical + required permission slug. */
  readonly confirmCriticalSlugs?: readonly string[];
  /** Admin opt-in: extend static analysis into node_modules; findings advisory only. */
  readonly deepScan?: boolean;
  /**
   * Exact re-entry of every forbidden import specifier static analysis
   * reported, accepting the risk and installing anyway.
   *
   * The gate is deliberately overridable. The specifier list is a lint for
   * honest authors, not a sandbox — obfuscation, a renamed vendored package,
   * or the global `fetch` all defeat it — so an unbypassable wall would stop
   * only the operators it was never aimed at, on hardware they own. BGE's
   * job is to state the risk precisely; the decision belongs to whoever runs
   * the instance. Per-specifier rather than a blanket flag, so a NEW
   * violation appearing in a later tarball cannot ride an old acceptance.
   */
  readonly acknowledgeForbiddenImports?: readonly string[];
}

export interface PluginInstallResult {
  readonly plugin: Plugin;
  readonly declaredPermissions: readonly PluginPermission[];
  /** Server-scope grants seeded by this install; per-unit consent starts empty. */
  readonly seededGrants: readonly PluginGrant[];
  /** Full analysis report — warnings and deep-scan advisories for the install response. */
  readonly analysis: StaticAnalysisReport;
  /** Author-guidance warnings from manifest validation, surfaced but never gating. */
  readonly warnings: readonly ManifestWarning[];
  /** Forbidden specifiers the installer accepted to bypass the analysis gate; empty on a clean install. */
  readonly acknowledgedForbiddenImports: readonly string[];
}

/**
 * The install orchestration seam (#59 Phase C2): manifest validation →
 * categorical exclusions → installer authority → core-permission
 * existence (step 3, DB half) → Critical second factor → static
 * analysis → one transaction persisting the `Plugin` row, its
 * `PluginPermission` catalog (fresh-install rows only), and the
 * server-scope grant seed → post-commit `plugin.installed` provenance.
 *
 * Input is a resolved directory plus typed provenance — ingress, SHA-256
 * verification, extraction, and the atomic move belong to the #84 pipeline
 * that wraps this service. The fresh-install denial-list check was
 * deliberately dropped: no `PluginGrant` rows can exist for a plugin
 * being created, and uninstall purges them, so denial at install is
 * expressed by the admin declining to confirm.
 *
 * The static-analysis gate is overridable by the installing admin
 * (`acknowledgeForbiddenImports`), because it is a lint rather than a
 * sandbox: BGE states the risk precisely and records the acceptance, but an
 * operator's instance is theirs to run. Nothing else here is overridable —
 * authority, permission existence, and the Critical second factor are
 * invariants of the consent model, not advice about code quality.
 *
 * Every server-consentable check is seeded `Granted`: completing the
 * install — with Critical slugs doubly confirmed — IS the server-scope
 * consent act. Household/user-consentable permissions are seeded NOTHING;
 * those decisions belong to their units via `PluginGrantService.decide`.
 */
@Injectable()
export class PluginInstallerService {
  private readonly logger = new Logger(PluginInstallerService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly staticAnalysis: PluginStaticAnalysisService,
    private readonly configSchema: PluginConfigSchemaService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  async install(input: PluginInstallInput): Promise<PluginInstallResult> {
    const initiatedAt = new Date();
    const { directory, provenance } = input;

    if (provenance.bundled !== directory.bundled) {
      throw new PluginInstallProvenanceMismatchError(
        directory.slug,
        `provenance says bundled=${provenance.bundled}, the directory resolved as bundled=${directory.bundled}`,
      );
    }

    const validated = await this.validateManifest(directory);
    this.assertNoForbiddenPluginPermissions(validated);

    if (!(await this.authority.isServerAdmin(input.installerId))) {
      throw new PluginInstallAuthorityError(input.installerId);
    }

    const corePermissions = await this.loadCorePermissions(validated);
    this.assertNoForbiddenCorePermissions(validated, corePermissions);

    const serverChecks = validated.permissionChecks.filter((check) => check.consentScope === 'server');
    this.assertCriticalConfirmation(validated, serverChecks, corePermissions, input.confirmCriticalSlugs ?? []);

    const analysis = await this.staticAnalysis.analyze(directory, { deepScan: input.deepScan ?? false });
    const acknowledgedForbiddenImports = this.resolveForbiddenAcknowledgement(
      directory.slug,
      gatingFindings(analysis),
      input.acknowledgeForbiddenImports ?? [],
    );

    // Compiled here rather than inside `persist`: the reinstall branch
    // validates retained config against this schema while holding the row
    // lock, and ajv's codegen has no business inside that window.
    this.configSchema.warm({
      slug: validated.manifest.slug,
      version: validated.manifest.version,
      schema: validated.manifest.config.schema,
    });

    const persisted = await this.persist(
      validated,
      provenance,
      input.installerId,
      serverChecks,
      corePermissions,
      initiatedAt,
    );

    const { retainedConfigReset, dormancyTransitions, ...persistedResult } = persisted;

    this.emitInstalled(
      persisted.plugin,
      provenance,
      serverChecks,
      analysis,
      acknowledgedForbiddenImports,
      retainedConfigReset,
      initiatedAt,
    );
    emitHouseholdDormancy(this.emitter, dormancyTransitions, validated.manifest.version, initiatedAt);
    this.logger.log(
      `Installed plugin '${persisted.plugin.slug}'@${persisted.plugin.version}: ` +
        `${persisted.declaredPermissions.length} declared permission(s), ${persisted.seededGrants.length} server grant(s) seeded` +
        (retainedConfigReset ? '; retained server config was schema-invalid and reset' : '') +
        (dormancyTransitions.length === 0
          ? ''
          : `; ${dormancyTransitions.length} household row(s) reconciled against the new manifest`),
    );

    return { ...persistedResult, analysis, warnings: validated.warnings, acknowledgedForbiddenImports };
  }

  /**
   * Full-enforcement validation — unlike consent-time re-validation
   * (`PluginGrantService`), install DOES gate on `bgeCompat`: a plugin that
   * cannot load under the running BGE must not be installable.
   */
  private async validateManifest(directory: InstalledPluginDirectory): Promise<PluginManifestValidationResult> {
    let raw: unknown;

    try {
      raw = JSON.parse(await readFile(directory.manifestPath, 'utf-8'));
    } catch (err) {
      throw new PluginInstallManifestError(
        directory.slug,
        `manifest.json could not be read or parsed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let validated: PluginManifestValidationResult;

    try {
      validated = validatePluginManifest(raw, {
        bgeVersion: this.options.bgeVersion,
        defaultLocale: this.options.defaultLocale,
      });
    } catch (err) {
      if (err instanceof PluginManifestValidationError) {
        throw new PluginInstallManifestError(directory.slug, 'manifest validation failed', err.issues);
      }

      throw err;
    }

    if (validated.manifest.slug !== directory.slug) {
      throw new PluginInstallManifestError(
        directory.slug,
        `manifest slug '${validated.manifest.slug}' does not match the directory it arrived in — ` +
          'canonical permission slugs and the on-disk identity must agree',
      );
    }

    return validated;
  }

  /**
   * Categorical exclusions on the plugin's OWN vocabulary, mirroring C1's
   * grant-time rule at the earlier seam (shared with the C3 update path via
   * `consent-gates.ts` — two drifting copies of a security invariant is how
   * version 2 becomes the smuggling path). Throws on the FIRST violation:
   * every grant for it would fail anyway, so the install must not create an
   * unsatisfiable consent surface.
   */
  private assertNoForbiddenPluginPermissions(validated: PluginManifestValidationResult): void {
    const [violation] = collectForbiddenPermissionViolations(validated);

    if (violation !== undefined) {
      throw new PluginInstallForbiddenPermissionError(
        validated.manifest.slug,
        violation.permissionSlug,
        violation.detail,
      );
    }
  }

  /** Validation step 3, DB half: every core `checks[]` slug must exist in `Permission`. Collect-all before failing. */
  private async loadCorePermissions(
    validated: PluginManifestValidationResult,
  ): Promise<ReadonlyMap<string, Permission>> {
    const slugs = validated.externalPermissionChecks;

    if (slugs.length === 0) {
      return new Map();
    }

    const rows = await this.db.permission.findMany({ where: { slug: { in: [...slugs] } } });
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    const missing = slugs.filter((slug) => !bySlug.has(slug));

    if (missing.length > 0) {
      throw new PluginInstallUnknownCorePermissionError(validated.manifest.slug, missing);
    }

    return bySlug;
  }

  private assertNoForbiddenCorePermissions(
    validated: PluginManifestValidationResult,
    corePermissions: ReadonlyMap<string, Permission>,
  ): void {
    const [violation] = [
      ...collectWildcardSubjectViolations(validated, corePermissions),
      ...collectUnboundedUnitConsentViolations(validated, corePermissions),
    ];

    if (violation !== undefined) {
      throw new PluginInstallForbiddenPermissionError(
        validated.manifest.slug,
        violation.permissionSlug,
        violation.detail,
      );
    }
  }

  /**
   * The Critical second factor (#59): EXACT re-entry — every Critical slug
   * this install will GRANT present, nothing else. Extra entries are
   * rejected too; a confirmation naming slugs that need no confirmation
   * means the caller and the server disagree about what is being consented
   * to.
   *
   * The set follows what is granted, NOT the manifest's `required` flag.
   * Step 14 as written keys the second factor on `required: true`, which
   * assumed optional permissions were not conferred at install; because
   * every server-consentable check is seeded `Granted` here, an
   * `required: false` Critical check would otherwise produce a byte-identical
   * grant with the confirmation silently skipped. `required` is the author's
   * claim about feature degradation, not a statement about risk, so the
   * gate tracks the authority actually being handed over.
   *
   * Plugin-declared permissions never qualify: their rows are locked to an
   * explicit `Low`, so only core checks can be Critical.
   */
  private assertCriticalConfirmation(
    validated: PluginManifestValidationResult,
    serverChecks: readonly NormalizedPermissionRequest[],
    corePermissions: ReadonlyMap<string, Permission>,
    confirmed: readonly string[],
  ): void {
    const expected = criticalConfirmationExpectation(serverChecks, corePermissions);
    const reentry = compareExactReentry(expected, confirmed);

    if (!reentry.exact) {
      throw new PluginInstallCriticalConfirmationError(validated.manifest.slug, reentry.expected, reentry.received);
    }
  }

  /**
   * Resolve the static-analysis gate against the installer's acceptance.
   *
   * Set equality on distinct specifiers, the same discipline the Critical
   * second factor uses: every reported specifier must be re-entered, and
   * naming one that analysis did not report is refused too — the acceptance
   * and the report have to describe the same install, or the admin is
   * consenting to a state the server is not in.
   *
   * Keyed on the SPECIFIER, not the finding: `axios` imported from nine
   * files is one decision, and making an operator enumerate nine file paths
   * would push them toward a blanket override, which is the outcome this
   * shape exists to prevent.
   *
   * Returns the accepted specifiers so they can be recorded on the install
   * event — the override is permitted, never silent.
   */
  private resolveForbiddenAcknowledgement(
    pluginSlug: string,
    gating: readonly StaticAnalysisFinding[],
    acknowledged: readonly string[],
  ): readonly string[] {
    const { reported, unacknowledged, unexpected } = resolveForbiddenSpecifierAcknowledgement(gating, acknowledged);

    if (unexpected.length > 0) {
      throw new PluginInstallStaticAnalysisError(pluginSlug, gating, unacknowledged, unexpected);
    }

    if (unacknowledged.length > 0) {
      throw new PluginInstallStaticAnalysisError(pluginSlug, gating, unacknowledged);
    }

    if (reported.length > 0) {
      this.logger.warn(
        `Plugin '${pluginSlug}' installed with ${reported.length} forbidden import(s) explicitly accepted by the ` +
          `installing admin: ${reported.join(', ')}. The plugin can reach these capabilities without host mediation; ` +
          'the acceptance is recorded on the install event.',
      );
    }

    return reported;
  }

  private async persist(
    validated: PluginManifestValidationResult,
    provenance: PluginInstallProvenance,
    installerId: string,
    serverChecks: readonly NormalizedPermissionRequest[],
    corePermissions: ReadonlyMap<string, Permission>,
    initiatedAt: Date,
  ): Promise<
    Pick<PluginInstallResult, 'plugin' | 'declaredPermissions' | 'seededGrants'> & {
      retainedConfigReset: boolean;
      /** Household rows a reinstall's manifest made dormant or revived (#369) — always empty for a fresh install. */
      dormancyTransitions: readonly HouseholdDormancyTransition[];
    }
  > {
    const manifest = validated.manifest;

    return this.db.$transaction(async (tx) => {
      const existing = await tx.plugin.findUnique({
        where: { slug: manifest.slug },
        select: { id: true, uninstalledAt: true, config: true },
      });

      // A LIVING row conflicts — updates are the C3 flow. A tombstone does
      // not: uninstall's inverse is reinstall, which clears it in place
      // below so the retained unit config keeps its foreign keys.
      if (existing !== null && existing.uninstalledAt === null) {
        throw new PluginInstallConflictError(manifest.slug);
      }

      // Step 4: the `PluginPermission.slug` unique index IS the collision
      // check; this pre-read exists for the readable error, and the index
      // backstops its race window (a P2002 aborts the transaction whole).
      const canonicalDeclares = validated.declaredPermissions.map((declared) => declared.canonicalSlug);
      const collisions =
        canonicalDeclares.length === 0
          ? []
          : await tx.pluginPermission.findMany({
              where: { slug: { in: canonicalDeclares } },
              select: { slug: true },
            });

      if (collisions.length > 0) {
        throw new PluginInstallPermissionCollisionError(
          manifest.slug,
          collisions.map((collision) => collision.slug),
        );
      }

      const sharedColumns = {
        version: manifest.version,
        category: MANIFEST_CATEGORY_TO_PRISMA[manifest.category],
        scope: MANIFEST_SCOPE_TO_PRISMA[manifest.scope],
        // The VALIDATED manifest object — the canonical form every later
        // re-validation (loader, grants, C3 comparison) starts from.
        manifestJson: manifest as Prisma.InputJsonValue,
        bundled: provenance.bundled,
        installedFromUrl: provenance.bundled ? null : (provenance.installedFromUrl ?? null),
        installedSha256: provenance.bundled ? null : provenance.installedSha256,
        registrySlug: provenance.bundled ? null : (provenance.registrySlug ?? null),
        installedById: installerId,
        installedAt: initiatedAt,
      };

      let plugin: Plugin;
      let retainedConfigReset = false;
      let dormancyTransitions: readonly HouseholdDormancyTransition[] = [];

      if (existing === null) {
        plugin = await tx.plugin.create({
          data: {
            slug: manifest.slug,
            ...sharedColumns,
            // Manifest hint; the column default covers an absent declaration.
            ...(manifest.executionMode === undefined
              ? {}
              : { executionMode: MANIFEST_EXECUTION_MODE_TO_PRISMA[manifest.executionMode] }),
          },
        });
      } else {
        const retained = this.retainedServerConfig(manifest, existing.config);
        retainedConfigReset = retained.reset;

        // Reinstall clears the tombstone in place. Consent starts from zero
        // (the uninstall purge emptied the catalog; re-seeded below), the
        // enable switch starts OFF like any fresh install, and the running
        // process may still hold the pre-uninstall module — restartRequired
        // says so until the loader's success path clears it.
        //
        // Guarded on the tombstone STILL being present, the way the unique
        // slug index guards a fresh install: two concurrent reinstalls both
        // read a tombstone, and without this the loser would overwrite the
        // winner's living row — a silent version/provenance swap the
        // permission-collision index only catches when the two installs
        // happen to declare overlapping permissions.
        const claimed = await tx.plugin.updateMany({
          where: { id: existing.id, uninstalledAt: { not: null } },
          data: {
            ...sharedColumns,
            // An absent hint must RESET to the default here — an update
            // applies no column defaults the way create does, so the value
            // is named rather than left to the database.
            executionMode:
              manifest.executionMode === undefined
                ? DEFAULT_PLUGIN_EXECUTION_MODE
                : MANIFEST_EXECUTION_MODE_TO_PRISMA[manifest.executionMode],
            enabled: false,
            uninstalledAt: null,
            restartRequired: true,
            loadFailed: false,
            loadError: null,
            config: retained.config as Prisma.InputJsonValue,
            // Stale signals about the uninstalled version.
            latestKnownVersion: null,
            latestKnownChannel: null,
            securityAdvisory: null,
            lastUpdateCheckAt: null,
            // Cleared by uninstall already; kept here so the row cannot
            // resurrect a staged update even if that invariant slips.
            ...CLEARED_STAGED_UPDATE,
          },
        });

        if (claimed.count !== 1) {
          throw new PluginInstallConflictError(manifest.slug);
        }

        plugin = await tx.plugin.findUniqueOrThrow({ where: { id: existing.id } });

        // A reinstall replaces a manifest, so it owns the same household-row
        // reconciliation activation does (#369, D-CK). `sharedColumns` above
        // rewrites `scope` from the new manifest, and an uninstall with
        // `purgeData: false` retained every household row as it stood — so
        // without this a household enabled under the old scope comes back
        // serving a plugin whose scope has no household surface, and the
        // serving predicate has no live scope check to catch it.
        //
        // Only in this branch: a FRESH install has no plugin row, so no
        // household row can reference one.
        dormancyTransitions = await reconcileHouseholdDormancy({
          tx,
          pluginId: plugin.id,
          manifest,
          configSchema: this.configSchema,
          initiatedAt,
        });
      }

      const declaredPermissions: PluginPermission[] = [];

      for (const declared of validated.declaredPermissions) {
        declaredPermissions.push(
          await tx.pluginPermission.create({
            data: {
              pluginId: plugin.id,
              slug: declared.canonicalSlug,
              // Explicit Low, never the manifest and never a schema
              // default: own-namespace slugs gate only the plugin's own
              // declared surface.
              riskLevel: RiskLevel.Low,
            },
          }),
        );
      }

      const seededGrants: PluginGrant[] = [];

      for (const check of serverChecks) {
        seededGrants.push(
          await tx.pluginGrant.create({
            data: {
              pluginId: plugin.id,
              scopeType: PluginGrantScope.Server,
              scopeId: SERVER_SCOPE_SENTINEL,
              permissionSlug: check.canonicalSlug,
              status: PluginGrantStatus.Granted,
              manifestVersion: manifest.version,
              decidedById: installerId,
              decidedAt: initiatedAt,
              decidedRiskLevel: this.riskFor(manifest.slug, check, corePermissions),
            },
          }),
        );
      }

      return { plugin, declaredPermissions, seededGrants, retainedConfigReset, dormancyTransitions };
    });
  }

  /**
   * Reinstall's retained-config rule: SERVER config rides the retained
   * `Plugin` row through an uninstall regardless of `purgeData` (that flag
   * scopes to the household/user rows, #320), and is carried forward ONLY if
   * it satisfies the NEW manifest's schema; otherwise it resets to `{}` and
   * the event records the reset. Failing the reinstall instead was rejected —
   * an admin whose only escape hatch destroys retained unit config is being
   * offered no choice at all. A schema that cannot compile proves nothing
   * about the retained value, so it resets too; the broken schema itself
   * surfaces loudly on the first config write.
   */
  private retainedServerConfig(
    manifest: PluginManifestValidationResult['manifest'],
    retained: Prisma.JsonValue,
  ): { config: Record<string, unknown>; reset: boolean } {
    const isPlainObject = typeof retained === 'object' && retained !== null && !Array.isArray(retained);

    if (!isPlainObject) {
      return { config: {}, reset: true };
    }

    const config = retained as Record<string, unknown>;

    try {
      const issues = this.configSchema.validate({
        slug: manifest.slug,
        version: manifest.version,
        schema: manifest.config.schema,
        config,
      });

      return issues.length === 0 ? { config, reset: false } : { config: {}, reset: true };
    } catch {
      return { config: {}, reset: true };
    }
  }

  private riskFor(
    pluginSlug: string,
    check: NormalizedPermissionRequest,
    corePermissions: ReadonlyMap<string, Permission>,
  ): RiskLevel {
    if (check.origin === 'plugin') {
      return RiskLevel.Low;
    }

    const permission = corePermissions.get(check.canonicalSlug);

    if (permission === undefined) {
      // Unreachable after loadCorePermissions; guards a future reordering.
      throw new PluginInstallUnknownCorePermissionError(pluginSlug, [check.canonicalSlug]);
    }

    return permission.riskLevel;
  }

  /**
   * Post-commit, matching the commit-then-emit discipline everywhere else.
   * The installed event carries the full grant summary; per-grant
   * `plugin.grant_created` events are deliberately NOT emitted for the seed
   * — those record decisions made through the consent surface, and the
   * seeded rows' provenance (including `decidedRiskLevel`) already lives on
   * the rows themselves and in this event's payload.
   */
  private emitInstalled(
    plugin: Plugin,
    provenance: PluginInstallProvenance,
    serverChecks: readonly NormalizedPermissionRequest[],
    analysis: StaticAnalysisReport,
    acknowledgedForbiddenImports: readonly string[],
    retainedConfigReset: boolean,
    initiatedAt: Date,
  ): void {
    const eventProvenance: PluginProvenance = provenance.bundled
      ? { installedFromUrl: null, installedSha256: null, registrySlug: null }
      : {
          installedFromUrl: provenance.installedFromUrl ?? null,
          installedSha256: provenance.installedSha256,
          registrySlug: provenance.registrySlug ?? null,
        };

    const grantedPermissions: GrantedPermissionRecord[] = serverChecks.map((check) => ({
      slug: check.canonicalSlug,
      required: check.required,
      consentScope: check.consentScope,
      reason: resolveLocalizedString(check.reason, {
        locale: this.options.defaultLocale,
        defaultLocale: this.options.defaultLocale,
      }),
    }));

    const event = new PluginInstalledEvent(
      {
        id: plugin.id,
        slug: plugin.slug,
        version: plugin.version,
        category: plugin.category,
        scope: plugin.scope,
        enabled: plugin.enabled,
        bundled: plugin.bundled,
      },
      {
        provenance: eventProvenance,
        grantedPermissions,
        // npm audit consultation is the #84 pipeline's step; it extends this
        // context with findings when it lands.
        auditFindings: null,
        // Includes any forbidden findings the admin accepted below — an
        // overridden install must record what it let through, not a report
        // filtered down to look clean.
        staticAnalysis: analysis.findings,
        acknowledgedForbiddenImports,
        retainedConfigReset,
      },
      initiatedAt,
    );

    this.emitter.emit(PluginInstalledEvent.eventName, event);
  }
}
