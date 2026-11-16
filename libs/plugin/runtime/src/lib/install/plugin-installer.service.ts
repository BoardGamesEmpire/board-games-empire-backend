import {
  DatabaseService,
  PluginCategory,
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
import type { PluginArtifactDirectory } from '@boardgamesempire/plugin-contract';
import {
  PluginManifestValidationError,
  resolveLocalizedString,
  validatePluginManifest,
  type ManifestWarning,
  type NormalizedPermissionRequest,
  type PluginManifest,
  type PluginManifestValidationResult,
} from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { readFile } from 'node:fs/promises';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { retainedServerConfig } from '../config/retained-server-config';
import { PluginInstalledEvent, type GrantedPermissionRecord, type PluginProvenance } from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { PluginDirectoryResolverService } from '../loader/plugin-directory-resolver.service';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { MANIFEST_CATEGORY_TO_PRISMA } from '../registry/plugin-category.map';
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
  PluginInstallDataGatewayNameConflictError,
  PluginInstallForbiddenPermissionError,
  PluginInstallManifestError,
  PluginInstallPermissionCollisionError,
  PluginInstallStaticAnalysisError,
  PluginInstallUnknownCorePermissionError,
  PluginReinstallConflictError,
} from './install.errors';
import {
  DEFAULT_PLUGIN_EXECUTION_MODE,
  MANIFEST_EXECUTION_MODE_TO_PRISMA,
  MANIFEST_SCOPE_TO_PRISMA,
} from './manifest-enum.maps';
import { findDataGatewayNameHolder, placePluginDataGatewayRow, pluginDataGatewayName } from './plugin-data-gateway-row';
import { PluginStaticAnalysisService } from './plugin-static-analysis.service';
import { gatingFindings, type StaticAnalysisFinding, type StaticAnalysisReport } from './static-analysis.types';

export interface PluginInstallInput {
  /**
   * The plugin artifact's directory, which the install ingress placed
   * (#1094); its checksum is the one the row records (#224). The
   * installer never opens the plugin artifact itself (#59).
   */
  readonly directory: PluginArtifactDirectory;
  /**
   * The link the plugin artifact was fetched from (#84). Omitted for a manual
   * upload, which has a checksum but no link. The checksum is the artifact
   * directory's own (#224), so it is not a second input that could disagree.
   */
  readonly url?: string;
  /** `PluginRegistrySource.slug` the artifact was discovered through (#84). */
  readonly registrySlug?: string;
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

/**
 * What `assess()` found in a plugin artifact: the validated manifest and
 * everything an install would ask the server admin to confirm (#1094).
 */
export interface PluginInstallAssessment {
  readonly validated: PluginManifestValidationResult;
  /** The checks the install would seed `Granted` at server scope. */
  readonly serverChecks: readonly NormalizedPermissionRequest[];
  readonly corePermissions: ReadonlyMap<string, Permission>;
  /** Critical slugs `install()` wants re-entered, sorted. */
  readonly criticalSlugsToReenter: readonly string[];
  readonly analysis: StaticAnalysisReport;
  /** Forbidden import specifiers `install()` wants acknowledged, distinct. */
  readonly forbiddenImportsToAccept: readonly string[];
  /**
   * The name a data-gateway plugin's DataGateway row would take, when another
   * row holds it and `install()` would refuse (#1083). Null when the install
   * would create no row under a taken name, and for every other category.
   */
  readonly dataGatewayNameConflict: string | null;
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
 * The install orchestration seam (#59 Phase C2): installer authority →
 * `assess()` (manifest validation → categorical exclusions →
 * core-permission existence (step 3, DB half) → static analysis) → Critical
 * confirmation → forbidden-import acknowledgement → one transaction
 * persisting the `Plugin` row, its `PluginPermission` catalog (fresh-install
 * rows only), and the server-scope grant seed → post-commit
 * `plugin.installed` provenance.
 *
 * Input is a resolved artifact directory plus its link and registry. The
 * install ingress, SHA-256 verification, extraction and placing the
 * directory belong to the #84 pipeline that wraps this service. The
 * fresh-install denial-list check was
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
    private readonly directories: PluginDirectoryResolverService,
  ) {}

  async install(input: PluginInstallInput): Promise<PluginInstallResult> {
    const initiatedAt = new Date();

    // Authority first, before the resolver stats the plugins root or the
    // directory, and before the manifest is read or analyzed: anyone but a
    // server admin gets no file-system signal at all (#1094).
    if (!(await this.authority.isServerAdmin(input.installerId))) {
      throw new PluginInstallAuthorityError(input.installerId);
    }

    // Before anything is read from it or recorded: the row is to name a
    // checksum the loader resolves at the next boot, so a directory the
    // resolver would refuse then is refused now, with the same error (#224).
    const directory = await this.directories.confirm(input.directory);
    // What the row and the installed event record: the checksum is the
    // artifact directory's own (#224), and a link or registry the install
    // leaves out is stored as null.
    const provenance: PluginProvenance = {
      sha256: directory.sha256,
      url: input.url ?? null,
      registrySlug: input.registrySlug ?? null,
    };

    const assessment = await this.assess(directory, { deepScan: input.deepScan });
    const { validated, serverChecks, corePermissions, analysis } = assessment;

    // Before the confirmation gates: no confirmation cures a taken name, so
    // the server admin is not asked to re-enter anything first (#1083). The
    // transaction's own check is the one that holds; this one is early.
    if (assessment.dataGatewayNameConflict !== null) {
      throw new PluginInstallDataGatewayNameConflictError(validated.manifest.slug, assessment.dataGatewayNameConflict);
    }

    this.assertCriticalConfirmation(validated, assessment.criticalSlugsToReenter, input.confirmCriticalSlugs ?? []);
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

    const { retainedConfigReset, ...persistedResult } = persisted;

    this.emitInstalled(
      persisted.plugin,
      provenance,
      serverChecks,
      analysis,
      acknowledgedForbiddenImports,
      retainedConfigReset,
      initiatedAt,
    );
    this.logger.log(
      `Installed plugin '${persisted.plugin.slug}'@${persisted.plugin.version}: ` +
        `${persisted.declaredPermissions.length} declared permission(s), ${persisted.seededGrants.length} server grant(s) seeded` +
        (retainedConfigReset ? '; retained server config was schema-invalid and reset' : ''),
    );

    return { ...persistedResult, analysis, warnings: validated.warnings, acknowledgedForbiddenImports };
  }

  /**
   * Everything an install would check about a plugin artifact, short of the
   * server admin's confirmations: manifest validation, the categorical
   * exclusions, core-permission existence and static analysis (#1094). The
   * artifact step calls it to show a server admin what the artifact asks for,
   * and `install()` calls it before it enforces the two confirmation gates, so
   * both see one assessment.
   *
   * It throws what those steps throw. It does not throw for a missing
   * confirmation: it reports what `install()` will ask the server admin to
   * re-enter.
   * It writes nothing, emits nothing and takes no actor, so the caller is
   * the one to check authority first.
   */
  async assess(
    directory: PluginArtifactDirectory,
    options: { readonly deepScan?: boolean } = {},
  ): Promise<PluginInstallAssessment> {
    const validated = await this.validateManifest(directory);
    this.assertNoForbiddenPluginPermissions(validated);

    const corePermissions = await this.loadCorePermissions(validated);
    this.assertNoForbiddenCorePermissions(validated, corePermissions);

    const serverChecks = validated.permissionChecks.filter((check) => check.consentScope === 'server');
    const analysis = await this.staticAnalysis.analyze(directory, { deepScan: options.deepScan ?? false });

    return {
      validated,
      serverChecks,
      corePermissions,
      criticalSlugsToReenter: criticalConfirmationExpectation(serverChecks, corePermissions),
      analysis,
      forbiddenImportsToAccept: resolveForbiddenSpecifierAcknowledgement(gatingFindings(analysis), []).reported,
      dataGatewayNameConflict: await this.findDataGatewayNameConflict(validated.manifest),
    };
  }

  /**
   * The name the plugin's DataGateway row would take, when installing it
   * would create the row under a taken name (#1083). An uninstalled plugin
   * keeps its row and its id, so its existing row's id goes along: a reinstall
   * creates no row and meets no name.
   *
   * Null while the slug's plugin is installed and live: that install is
   * refused as already installed (an update goes through the staged-update
   * flow), so it would never reach the row, and a name conflict would name
   * the wrong cause.
   */
  private async findDataGatewayNameConflict(manifest: PluginManifest): Promise<string | null> {
    if (MANIFEST_CATEGORY_TO_PRISMA[manifest.category] !== PluginCategory.DataGateway) {
      return null;
    }

    const existing = await this.db.plugin.findUnique({
      where: { slug: manifest.slug },
      select: { id: true, uninstalledAt: true },
    });

    if (existing !== null && existing.uninstalledAt === null) {
      return null;
    }

    const name = pluginDataGatewayName(manifest, this.options.defaultLocale);
    const holder = await findDataGatewayNameHolder(this.db, name, existing?.id ?? null);

    return holder === null ? null : name;
  }

  /**
   * Full-enforcement validation — unlike consent-time re-validation
   * (`PluginGrantService`), install DOES gate on `bgeCompat`: a plugin that
   * cannot load under the running BGE must not be installable.
   */
  private async validateManifest(directory: PluginArtifactDirectory): Promise<PluginManifestValidationResult> {
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

  /**
   * Validation step 3, DB half: every core `checks[]` slug must exist in
   * `Permission` and not be retired — a retired slug (#235) reads as unknown
   * here, so a manifest cannot bind to it. Collect-all before failing.
   */
  private async loadCorePermissions(
    validated: PluginManifestValidationResult,
  ): Promise<ReadonlyMap<string, Permission>> {
    const slugs = validated.externalPermissionChecks;

    if (slugs.length === 0) {
      return new Map();
    }

    const rows = await this.db.permission.findMany({ where: { slug: { in: [...slugs] }, retiredAt: null } });
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
    expected: readonly string[],
    confirmed: readonly string[],
  ): void {
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
    provenance: PluginProvenance,
    installerId: string,
    serverChecks: readonly NormalizedPermissionRequest[],
    corePermissions: ReadonlyMap<string, Permission>,
    initiatedAt: Date,
  ): Promise<
    Pick<PluginInstallResult, 'plugin' | 'declaredPermissions' | 'seededGrants'> & {
      retainedConfigReset: boolean;
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
        installedFromUrl: provenance.url,
        installedSha256: provenance.sha256,
        registrySlug: provenance.registrySlug,
        installedById: installerId,
        installedAt: initiatedAt,
      };

      let plugin: Plugin;
      let retainedConfigReset = false;

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
        const retained = retainedServerConfig(this.configSchema, manifest, existing.config);
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
          throw new PluginReinstallConflictError(manifest.slug);
        }

        plugin = await tx.plugin.findUniqueOrThrow({ where: { id: existing.id } });

        // A reinstall reads and writes no household unit enablement: whether a
        // retained one can run under this manifest is worked out when read (#1151).
      }

      // A data-gateway plugin's DataGateway row, created or (on a reinstall)
      // enabled in the same transaction as the plugin row it names (#1083).
      if (sharedColumns.category === PluginCategory.DataGateway) {
        await placePluginDataGatewayRow(tx, {
          pluginId: plugin.id,
          name: pluginDataGatewayName(manifest, this.options.defaultLocale),
          installerId,
          nameTaken: (name) => new PluginInstallDataGatewayNameConflictError(manifest.slug, name),
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
              decidedById: installerId,
              decidedAt: initiatedAt,
              decidedRiskLevel: this.riskFor(manifest.slug, check, corePermissions),
            },
          }),
        );
      }

      return { plugin, declaredPermissions, seededGrants, retainedConfigReset };
    });
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
    provenance: PluginProvenance,
    serverChecks: readonly NormalizedPermissionRequest[],
    analysis: StaticAnalysisReport,
    acknowledgedForbiddenImports: readonly string[],
    retainedConfigReset: boolean,
    initiatedAt: Date,
  ): void {
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
      },
      {
        provenance,
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
