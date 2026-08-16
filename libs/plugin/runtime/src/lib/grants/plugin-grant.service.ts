import {
  DatabaseService,
  hasBoundingConditions,
  PluginGrantScope,
  PluginGrantStatus,
  riskCovers,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
  type Plugin,
  type PluginGrant,
} from '@bge/database';
import {
  parsePluginPermissionSlug,
  type NormalizedPermissionRequest,
  type PluginManifestValidationResult,
} from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  HouseholdPluginUnitEnabledEvent,
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  PluginGrantRevokedEvent,
  UserPluginUnitEnabledEvent,
  type PluginGrantRevocationReason,
} from '../events/plugin.events';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from './consent-scope.map';
import {
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantManifestInvalidError,
  PluginGrantPluginNotFoundError,
  PluginGrantPluginTombstonedError,
  PluginGrantScopeIdError,
  PluginGrantScopeNotRevocableError,
  PluginGrantUnknownPermissionError,
} from './grant.errors';
import { isPluginAdministrationSlug } from './plugin-admin-permissions';
import { PluginGrantAuthorityService } from './plugin-grant-authority.service';

export interface PluginGrantDecisionInput {
  readonly pluginId: string;
  readonly scopeType: PluginGrantScope;
  /** Household.id / User.id for the matching scopeType; omit for Server. */
  readonly scopeId?: string;
  /** CANONICAL slug: `plugin|<slug>|<bare>` for plugin-declared permissions, the core slug otherwise. */
  readonly permissionSlug: string;
  readonly status: PluginGrantStatus;
  /** The consenting user — authority is verified, never assumed. */
  readonly deciderId: string;
}

export interface PluginGrantDecisionResult {
  readonly grant: PluginGrant;
  /** False when the decision was an exact re-statement (idempotent, no write, no event). */
  readonly changed: boolean;
}

/** Authority-loss revocation input (#211): always unit-addressed, never Server-scope. */
export interface PluginGrantRevocationInput {
  readonly scopeType: Exclude<PluginGrantScope, typeof PluginGrantScope.Server>;
  readonly scopeId: string;
  readonly reason: PluginGrantRevocationReason;
  /** Restrict to one plugin (e.g. household-plugin teardown); omit to revoke the unit's grants across all plugins. */
  readonly pluginId?: string;
}

/**
 * The consent write path (#59 Phase C1). Owns every `PluginGrant` mutation:
 * per-unit decisions (grant/deny with grant-time authority verification),
 * the user enablement anchor a Granted user-scope decision creates (#225),
 * and authority-loss revocation (delete-to-pending, #211).
 * Reads for ability resolution deliberately live elsewhere —
 * `PermissionsService` queries `PluginGrant` directly, keeping the
 * permissions lib off this one.
 *
 * Events are emitted AFTER the transaction commits (the same
 * commit-then-emit discipline the rest of the mutation pipeline follows),
 * so the post-commit lifecycle listener persists provenance for rows
 * that actually exist.
 */
@Injectable()
export class PluginGrantService {
  private readonly logger = new Logger(PluginGrantService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Record a consent decision for one (plugin, unit, permission). Upsert
   * semantics on the unique quadruple: polarity flips update the row in
   * place; an exact re-statement (same status, manifest version, and risk)
   * is a no-op — no write, no event.
   */
  async decide(input: PluginGrantDecisionInput): Promise<PluginGrantDecisionResult> {
    const initiatedAt = new Date();
    const plugin = await this.loadPlugin(input.pluginId);
    const { check, validated } = this.resolveRequestedCheck(plugin, input.permissionSlug);

    this.assertScopeCoherence(check, input);
    const scopeId = this.normalizeScopeId(input);
    const decidedRiskLevel = await this.resolveRiskLevel(plugin, check);
    await this.assertDeciderAuthority(input, scopeId);

    const uniqueWhere = {
      pluginId_scopeType_scopeId_permissionSlug: {
        pluginId: plugin.id,
        scopeType: input.scopeType,
        scopeId,
        permissionSlug: check.canonicalSlug,
      },
    };

    type DecisionOutcome =
      | { readonly unchanged: true; readonly grant: PluginGrant }
      | { readonly unchanged: false; readonly before: PluginGrant | null; readonly after: PluginGrant };

    const outcome = await this.db.$transaction(async (tx): Promise<DecisionOutcome> => {
      const existing = await tx.pluginGrant.findUnique({ where: uniqueWhere });

      if (
        existing !== null &&
        existing.status === input.status &&
        existing.manifestVersion === plugin.version &&
        existing.decidedRiskLevel === decidedRiskLevel
      ) {
        return { unchanged: true, grant: existing };
      }

      const decisionFields = {
        status: input.status,
        decidedById: input.deciderId,
        decidedAt: initiatedAt,
        manifestVersion: plugin.version,
        decidedRiskLevel,
      };

      // Upsert, not create-vs-update: findUnique-then-create is not atomic
      // under READ COMMITTED, and two concurrent identical decisions would
      // otherwise leave the loser with an unhandled P2002 instead of the
      // documented idempotent outcome. The pre-read still serves the
      // idempotency short-circuit and the event's before snapshot; in the
      // narrow race window both writers emit, which is acceptable duplicate
      // provenance rather than a failure.
      const written = await tx.pluginGrant.upsert({
        where: uniqueWhere,
        create: {
          pluginId: plugin.id,
          scopeType: input.scopeType,
          scopeId,
          permissionSlug: check.canonicalSlug,
          ...decisionFields,
        },
        update: decisionFields,
      });

      // The consent act IS the enabling act (#225): a Granted user-scope
      // decision ensures the user's enablement anchor exists, atomically
      // with the decision — committing consent without the row would leave
      // a user who consented but is not enabled, a state only another
      // decision could heal. The update arm is deliberately empty: the row
      // may exist suspended or user-disabled, and consent never writes
      // `enabled` or clears a suspension here — the late-acceptance
      // re-enable path below owns that transition, with its own predicate.
      // A Denied decision creates no row: a refusal confers no enablement,
      // and the durable denial already lives on the grant row itself.
      if (input.status === PluginGrantStatus.Granted && input.scopeType === PluginGrantScope.User) {
        await tx.userPlugin.upsert({
          where: { userId_pluginId: { userId: scopeId, pluginId: plugin.id } },
          create: { userId: scopeId, pluginId: plugin.id },
          update: {},
        });
      }

      return { unchanged: false, before: existing, after: written };
    });

    if (outcome.unchanged) {
      return { grant: outcome.grant, changed: false };
    }

    const EventClass = input.status === PluginGrantStatus.Granted ? PluginGrantCreatedEvent : PluginGrantRejectedEvent;
    const event = new EventClass(
      outcome.before === null ? null : this.snapshot(outcome.before),
      this.snapshot(outcome.after),
      initiatedAt,
    );
    this.emitter.emit(EventClass.eventName, event);

    // Late acceptance re-enables: a CHANGED unit-scope `Granted`
    // decision is the only transition that can clear a consent suspension,
    // so the check rides the decision itself rather than a sweeper. Same
    // shape at both unit scopes (#225).
    if (input.status === PluginGrantStatus.Granted) {
      if (input.scopeType === PluginGrantScope.Household) {
        await this.maybeReenableSuspendedHousehold(plugin, validated, scopeId, check, initiatedAt);
      } else if (input.scopeType === PluginGrantScope.User) {
        await this.maybeReenableSuspendedUser(plugin, validated, scopeId, check, initiatedAt);
      }
    }

    return { grant: outcome.after, changed: true };
  }

  /**
   * Clear a unit's `suspendedForConsent` once the household's consent state
   * satisfies the ACTIVE manifest, and emit `plugin.unit_enabled`
   * (#59). Evaluated on every changed Household grant rather than only
   * on escalated slugs — self-healing: if an intervening update removed a
   * requirement, the next consent still lifts a suspension that no longer
   * has outstanding slugs.
   *
   * "Satisfies" MUST mean the same thing here as in the update's suspension
   * pass, or a unit oscillates: suspended by activation, then cleared by an
   * unrelated consent that never addressed what suspended it. So a slug is
   * outstanding when it is required and ungranted, OR when it is granted at
   * a `decidedRiskLevel` that no longer covers today's catalog risk —
   * presence of a `Granted` row is not consent at a risk nobody was shown.
   *
   * Failures are logged, never thrown: the decision above is already
   * committed and emitted, and making a caller retry a recorded consent
   * because the re-enable bookkeeping hiccuped would be worse than a unit
   * that stays suspended until its next decision re-runs this check.
   */
  private async maybeReenableSuspendedHousehold(
    plugin: Plugin,
    validated: PluginManifestValidationResult,
    householdId: string,
    check: NormalizedPermissionRequest,
    initiatedAt: Date,
  ): Promise<void> {
    try {
      const unit = await this.db.householdPlugin.findUnique({
        where: { householdId_pluginId: { householdId, pluginId: plugin.id } },
      });

      if (unit === null || !unit.suspendedForConsent) {
        return;
      }

      const householdChecks = validated.permissionChecks.filter((candidate) => candidate.consentScope === 'household');

      if (
        householdChecks.length > 0 &&
        !(await this.unitConsentSatisfied(plugin, PluginGrantScope.Household, householdId, householdChecks))
      ) {
        return;
      }

      // Guarded update, not a blind write: a concurrent decision may have
      // cleared the suspension already, and only the writer that actually
      // flipped the row emits.
      const cleared = await this.db.householdPlugin.updateMany({
        where: { id: unit.id, suspendedForConsent: true },
        data: { suspendedForConsent: false, suspendedAt: null },
      });

      if (cleared.count !== 1) {
        return;
      }

      const snapshot = (suspendedForConsent: boolean) => ({
        id: unit.id,
        householdId: unit.householdId,
        pluginId: unit.pluginId,
        enabled: unit.enabled,
        suspendedForConsent,
      });

      this.emitter.emit(
        HouseholdPluginUnitEnabledEvent.eventName,
        new HouseholdPluginUnitEnabledEvent(
          snapshot(true),
          snapshot(false),
          check.canonicalSlug,
          plugin.version,
          initiatedAt,
        ),
      );
      this.logger.log(
        `Household '${householdId}' re-enabled for plugin '${plugin.slug}': consent for '${check.canonicalSlug}' ` +
          'cleared the last outstanding required permission (late acceptance)',
      );
    } catch (err) {
      this.logger.error(
        `Re-enable check failed for household '${householdId}' / plugin '${plugin.slug}' — the grant decision is ` +
          `committed; the unit stays suspended until its next decision re-runs this check: ${
            err instanceof Error ? err.message : err
          }`,
      );
    }
  }

  /**
   * The user-scope mirror of the household re-enable above (#225): same
   * predicate, same guarded write, same never-throw posture — the two
   * differ only in the unit delegate, the check filter, and the event
   * class. Kept as a sibling rather than folded into one parameterized
   * method: the delegates and snapshot shapes are different types, and the
   * duplication is the readable kind.
   */
  private async maybeReenableSuspendedUser(
    plugin: Plugin,
    validated: PluginManifestValidationResult,
    userId: string,
    check: NormalizedPermissionRequest,
    initiatedAt: Date,
  ): Promise<void> {
    try {
      const unit = await this.db.userPlugin.findUnique({
        where: { userId_pluginId: { userId, pluginId: plugin.id } },
      });

      if (unit === null || !unit.suspendedForConsent) {
        return;
      }

      const userChecks = validated.permissionChecks.filter((candidate) => candidate.consentScope === 'user');

      if (
        userChecks.length > 0 &&
        !(await this.unitConsentSatisfied(plugin, PluginGrantScope.User, userId, userChecks))
      ) {
        return;
      }

      // Guarded update, not a blind write: a concurrent decision may have
      // cleared the suspension already, and only the writer that actually
      // flipped the row emits.
      const cleared = await this.db.userPlugin.updateMany({
        where: { id: unit.id, suspendedForConsent: true },
        data: { suspendedForConsent: false, suspendedAt: null },
      });

      if (cleared.count !== 1) {
        return;
      }

      const snapshot = (suspendedForConsent: boolean) => ({
        id: unit.id,
        userId: unit.userId,
        pluginId: unit.pluginId,
        enabled: unit.enabled,
        suspendedForConsent,
      });

      this.emitter.emit(
        UserPluginUnitEnabledEvent.eventName,
        new UserPluginUnitEnabledEvent(
          snapshot(true),
          snapshot(false),
          check.canonicalSlug,
          plugin.version,
          initiatedAt,
        ),
      );
      this.logger.log(
        `User '${userId}' re-enabled for plugin '${plugin.slug}': consent for '${check.canonicalSlug}' ` +
          'cleared the last outstanding required permission (late acceptance)',
      );
    } catch (err) {
      this.logger.error(
        `Re-enable check failed for user '${userId}' / plugin '${plugin.slug}' — the grant decision is ` +
          `committed; the unit stays suspended until its next decision re-runs this check: ${
            err instanceof Error ? err.message : err
          }`,
      );
    }
  }

  /**
   * Does this unit's consent state satisfy every check of the active
   * manifest at its consent scope? Required checks need a `Granted` row;
   * any check that HAS one needs its recorded risk to still cover the
   * catalog's current classification. Mirrors the update service's
   * suspension predicate exactly — the two must agree or suspensions
   * bounce. Scope-parametric (#225): callers pass the checks pre-filtered
   * to the matching `consentScope`.
   */
  private async unitConsentSatisfied(
    plugin: Plugin,
    scopeType: Exclude<PluginGrantScope, typeof PluginGrantScope.Server>,
    scopeId: string,
    unitChecks: readonly NormalizedPermissionRequest[],
  ): Promise<boolean> {
    const granted = await this.db.pluginGrant.findMany({
      where: {
        pluginId: plugin.id,
        scopeType,
        scopeId,
        status: PluginGrantStatus.Granted,
        permissionSlug: { in: unitChecks.map((check) => check.canonicalSlug) },
      },
      select: { permissionSlug: true, decidedRiskLevel: true },
    });
    const decidedBySlug = new Map(granted.map((row) => [row.permissionSlug, row.decidedRiskLevel]));

    // Plugin-declared rows are locked to an explicit Low; core risk is
    // today's classification, read fresh rather than reconstructed.
    const coreSlugs = unitChecks.filter((check) => check.origin === 'core').map((check) => check.canonicalSlug);
    const coreRisks =
      coreSlugs.length === 0
        ? []
        : await this.db.permission.findMany({
            where: { slug: { in: coreSlugs } },
            select: { slug: true, riskLevel: true },
          });
    const currentRiskBySlug = new Map(coreRisks.map((row) => [row.slug, row.riskLevel]));

    for (const check of unitChecks) {
      const decidedRiskLevel = decidedBySlug.get(check.canonicalSlug);

      if (decidedRiskLevel === undefined) {
        if (check.required) {
          return false;
        }

        continue;
      }

      const currentRiskLevel =
        check.origin === 'plugin' ? RiskLevel.Low : (currentRiskBySlug.get(check.canonicalSlug) ?? RiskLevel.Low);

      if (!riskCovers(decidedRiskLevel, currentRiskLevel)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Delete-to-pending revocation on authority loss (#211): GRANTED
   * rows are removed — returning those permissions to pending — and one
   * `plugin.grant_revoked` event per row carries the only durable record of
   * what lapsed and why into the lifecycle table. `Denied` rows are
   * deliberately untouched: a denial wields no authority, so there is
   * nothing to revoke, and deleting it would re-open a permission the unit
   * durably refused (#59 durable-denial model).
   *
   * Returns exactly the rows this call deleted — never rows a concurrent
   * decision saved from deletion.
   */
  async revokeForAuthorityLoss(input: PluginGrantRevocationInput): Promise<readonly PluginGrant[]> {
    const initiatedAt = new Date();

    // Type-level Exclude + runtime guard: Server grants are never
    // authority-revoked — they live and die with the plugin row (cascade).
    if ((input.scopeType as PluginGrantScope) === PluginGrantScope.Server) {
      throw new PluginGrantScopeNotRevocableError(PluginGrantScope.Server);
    }

    if (input.scopeId === SERVER_SCOPE_SENTINEL) {
      throw new PluginGrantScopeIdError(input.scopeType, 'scopeId must identify the unit losing authority');
    }

    const revoked = await this.db.$transaction(async (tx) => {
      const rows = await tx.pluginGrant.findMany({
        where: {
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          status: PluginGrantStatus.Granted,
          ...(input.pluginId === undefined ? {} : { pluginId: input.pluginId }),
        },
      });

      if (rows.length === 0) {
        return { deleted: rows, survived: rows };
      }

      const ids = rows.map((row) => row.id);

      // The status predicate is repeated on the DELETE, not just the SELECT:
      // a concurrent decision could flip a row to Denied between the two
      // statements, and deleting by id alone would destroy that denial.
      const removed = await tx.pluginGrant.deleteMany({
        where: { id: { in: ids }, status: PluginGrantStatus.Granted },
      });

      if (removed.count === rows.length) {
        return { deleted: rows, survived: [] };
      }

      // Counts disagree, so at least one row was flipped and skipped. Read
      // back inside the same transaction to learn WHICH: a lifecycle row
      // saying a grant was revoked when it actually became a denial is worse
      // than a slow path here, and the caller's return value must not claim
      // rows it did not remove either.
      const survivors = await tx.pluginGrant.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const survivingIds = new Set(survivors.map((survivor) => survivor.id));

      return {
        deleted: rows.filter((row) => !survivingIds.has(row.id)),
        survived: rows.filter((row) => survivingIds.has(row.id)),
      };
    });

    if (revoked.survived.length > 0) {
      this.logger.warn(
        `Revocation for ${input.scopeType} '${input.scopeId}' left ${revoked.survived.length} row(s) intact — a concurrent decision flipped them to Denied between the read and the delete; no revocation event emitted for those.`,
      );
    }

    for (const row of revoked.deleted) {
      const event = new PluginGrantRevokedEvent(this.snapshot(row), input.reason, initiatedAt);
      this.emitter.emit(PluginGrantRevokedEvent.eventName, event);
    }

    if (revoked.deleted.length > 0) {
      this.logger.warn(
        `Revoked ${revoked.deleted.length} grant(s) for ${input.scopeType} '${input.scopeId}' (${input.reason})`,
      );
    }

    return revoked.deleted;
  }

  private async loadPlugin(pluginId: string): Promise<Plugin> {
    const plugin = await this.db.plugin.findUnique({ where: { id: pluginId } });

    if (plugin === null) {
      throw new PluginGrantPluginNotFoundError(pluginId);
    }

    // Tombstones at the consent seam (#225): a tombstoned plugin is not a
    // decision target at ANY scope — same posture as the update service.
    // `Plugin.enabled` deliberately does NOT gate here: the kill switch
    // decides when consent is ACTIONABLE, not whether it is decidable, and
    // consenting before an admin enables is a legitimate ordering.
    if (plugin.uninstalledAt !== null) {
      throw new PluginGrantPluginTombstonedError(plugin.slug, plugin.uninstalledAt);
    }

    return plugin;
  }

  /**
   * Grants exist only for permissions the manifest REQUESTED. The stored
   * manifest is re-validated through the shared contract
   * (`revalidateStoredManifest`: `enforceBgeCompat: false`, slug/version
   * agreement with the row — a BGE upgrade past the plugin's range must not
   * make its grants, or even a denial, undecidable). Failures are wrapped
   * in `PluginGrantManifestInvalidError` so C4 has a grant-domain error to
   * map — an invalid stored manifest is corrupted server state, never a
   * caller mistake.
   */
  private resolveRequestedCheck(
    plugin: Plugin,
    permissionSlug: string,
  ): { readonly check: NormalizedPermissionRequest; readonly validated: PluginManifestValidationResult } {
    const validated = revalidateStoredManifest(
      { slug: plugin.slug, version: plugin.version, manifestJson: plugin.manifestJson },
      this.options,
      (pluginSlug, detail, issues) => new PluginGrantManifestInvalidError(pluginSlug, detail, issues),
    );

    const check = validated.permissionChecks.find((candidate) => candidate.canonicalSlug === permissionSlug);

    if (check === undefined) {
      throw new PluginGrantUnknownPermissionError(
        plugin.slug,
        permissionSlug,
        'not requested by the manifest (decisions address canonical slugs: plugin|<slug>|<bare> or a core slug)',
      );
    }

    return { check, validated };
  }

  private assertScopeCoherence(check: NormalizedPermissionRequest, input: PluginGrantDecisionInput): void {
    const expected = CONSENT_SCOPE_TO_GRANT_SCOPE[check.consentScope];

    if (expected !== input.scopeType) {
      throw new PluginGrantConsentScopeMismatchError(check.canonicalSlug, expected, input.scopeType);
    }
  }

  private normalizeScopeId(input: PluginGrantDecisionInput): string {
    if (input.scopeType === PluginGrantScope.Server) {
      if (input.scopeId !== undefined && input.scopeId !== SERVER_SCOPE_SENTINEL) {
        throw new PluginGrantScopeIdError(input.scopeType, 'Server-scope decisions carry no unit id');
      }

      return SERVER_SCOPE_SENTINEL;
    }

    if (input.scopeId === undefined || input.scopeId === SERVER_SCOPE_SENTINEL) {
      throw new PluginGrantScopeIdError(input.scopeType, 'a Household/User decision must identify its unit');
    }

    return input.scopeId;
  }

  /**
   * Resolve the risk captured on the row — and enforce the categorical
   * exclusions on the way: plugin-administration slugs (a self-escalation
   * loop) and `'all'`-wildcard-subject permissions are never
   * grantable to plugin principals, regardless of who consents.
   */
  private async resolveRiskLevel(plugin: Plugin, check: NormalizedPermissionRequest): Promise<RiskLevel> {
    if (check.origin === 'plugin') {
      // The categorical exclusions apply to the BARE form too — defense in
      // depth for the ability factory (#60): a naively mapped subjectPath
      // would turn a declared `manage:all` into CASL's universal subject,
      // and a declared `manage:plugin` invites the same self-escalation
      // confusion the administration exclusion exists to shut out. Neither
      // has a legitimate reading.
      const parsed = parsePluginPermissionSlug(check.canonicalSlug);

      if (isPluginAdministrationSlug(parsed.bareSlug)) {
        throw new PluginGrantExclusionError(
          check.canonicalSlug,
          'a plugin-declared permission may not mimic the plugin-administration vocabulary (the hard exclusion applies to the bare form)',
        );
      }

      if (parsed.subjectPath === 'all' || parsed.subjectPath.startsWith('all:')) {
        throw new PluginGrantExclusionError(
          check.canonicalSlug,
          "a plugin-declared permission may not claim the 'all' subject — a naive CASL mapping would read it as wildcard authority",
        );
      }

      const declared = await this.db.pluginPermission.findUnique({ where: { slug: check.canonicalSlug } });

      if (declared === null) {
        throw new PluginGrantUnknownPermissionError(
          plugin.slug,
          check.canonicalSlug,
          'declared permission has no PluginPermission catalog row — the install pipeline (#59 C2) creates these',
        );
      }

      return declared.riskLevel;
    }

    if (isPluginAdministrationSlug(check.canonicalSlug)) {
      throw new PluginGrantExclusionError(
        check.canonicalSlug,
        'plugin-administration authority granted to a plugin is a self-escalation loop',
      );
    }

    const permission = await this.db.permission.findUnique({ where: { slug: check.canonicalSlug } });

    if (permission === null) {
      throw new PluginGrantUnknownPermissionError(
        plugin.slug,
        check.canonicalSlug,
        'core permission does not exist — if this was meant to be a plugin-declared permission, add it to permissions.declares',
      );
    }

    if (permission.subject === 'all') {
      throw new PluginGrantExclusionError(
        check.canonicalSlug,
        "wildcard-subject ('all') authority is never grantable to a plugin — same rule AbilityFactory applies to direct assignment",
      );
    }

    // Unit-boundedness (#60): a condition-free core permission is
    // subject-wide authority, and a household/user cannot consent to more
    // than its own slice. Refused here rather than recorded as a grant the
    // read path would ignore — a decision that can never confer is not a
    // decision, it is a trap for whoever reads the consent screen.
    if (check.consentScope !== 'server' && !hasBoundingConditions(permission.conditions)) {
      throw new PluginGrantExclusionError(
        check.canonicalSlug,
        'a condition-free core permission cannot be consented at household/user scope — nothing bounds the ' +
          'conferred authority to the consenting unit; only server consent can confer it (or seed a ' +
          'unit-conditioned variant, #315)',
      );
    }

    return permission.riskLevel;
  }

  private async assertDeciderAuthority(
    input: PluginGrantDecisionInput,
    /** Output of `normalizeScopeId` — the sentinel for Server, a verified non-empty unit id otherwise. */
    scopeId: string,
  ): Promise<void> {
    switch (input.scopeType) {
      case PluginGrantScope.Server: {
        if (!(await this.authority.isServerAdmin(input.deciderId))) {
          throw new PluginGrantAuthorityError(input.deciderId, 'Server-scope consent requires a server admin');
        }

        return;
      }
      case PluginGrantScope.Household: {
        const householdId = scopeId;

        if (!(await this.authority.isHouseholdAdmin(input.deciderId, householdId))) {
          throw new PluginGrantAuthorityError(
            input.deciderId,
            `Household-scope consent requires an owner/admin membership in household '${householdId}'`,
          );
        }

        return;
      }
      case PluginGrantScope.User: {
        // The subject check is the WHOLE user-scope authority predicate
        // (#225 uniform enablement): the remaining conditions — plugin not
        // tombstoned, manifest requests the permission at user scope — are
        // enforced by loadPlugin and resolveRequestedCheck/
        // assertScopeCoherence before this switch runs. Household
        // membership is irrelevant to a user's consent about their own
        // data.
        if (input.deciderId !== scopeId) {
          throw new PluginGrantAuthorityError(input.deciderId, 'User-scope consent is decided by the user themself');
        }

        return;
      }
    }
  }

  private snapshot(row: PluginGrant) {
    const { id, pluginId, scopeType, scopeId, permissionSlug, status, manifestVersion, decidedRiskLevel } = row;

    return { id, pluginId, scopeType, scopeId, permissionSlug, status, manifestVersion, decidedRiskLevel };
  }
}
