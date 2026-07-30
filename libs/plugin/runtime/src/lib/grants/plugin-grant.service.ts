import {
  DatabaseService,
  PluginGrantScope,
  PluginGrantStatus,
  type Plugin,
  type PluginGrant,
  type RiskLevel,
} from '@bge/database';
import {
  parsePluginPermissionSlug,
  PluginManifestValidationError,
  validatePluginManifest,
  type NormalizedPermissionRequest,
  type PluginConsentScopeValue,
  type PluginManifestValidationResult,
} from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  PluginGrantRevokedEvent,
  type PluginGrantRevocationReason,
} from '../events/plugin.events';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import {
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantManifestInvalidError,
  PluginGrantPluginNotFoundError,
  PluginGrantScopeIdError,
  PluginGrantScopeNotRevocableError,
  PluginGrantUnknownPermissionError,
} from './grant.errors';
import { isPluginAdministrationSlug } from './plugin-admin-permissions';
import { PluginGrantAuthorityService } from './plugin-grant-authority.service';

/** The empty-string uniqueness sentinel Server-scope rows store (see plugin-grant.prisma). Shared with the installer's grant seeding. */
export const SERVER_SCOPE_SENTINEL = '' as const;

const CONSENT_SCOPE_TO_GRANT_SCOPE: Readonly<Record<PluginConsentScopeValue, PluginGrantScope>> = {
  server: PluginGrantScope.Server,
  household: PluginGrantScope.Household,
  user: PluginGrantScope.User,
};

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
 * per-unit decisions (grant/deny with grant-time authority verification)
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
    const check = this.resolveRequestedCheck(plugin, input.permissionSlug);

    this.assertScopeCoherence(check, input);
    const scopeId = this.normalizeScopeId(input);
    const decidedRiskLevel = await this.resolveRiskLevel(plugin, check);
    await this.assertDeciderAuthority(input, plugin, scopeId);

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

    return { grant: outcome.after, changed: true };
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

    return plugin;
  }

  /**
   * Grants exist only for permissions the manifest REQUESTED. The stored
   * manifest is re-validated (same discipline as the loader), with two
   * consent-specific differences:
   *
   * - `enforceBgeCompat: false` — whether the plugin can LOAD under the
   *   current BGE is irrelevant to recording a decision about it; a BGE
   *   upgrade past the plugin's range must not make its grants (or even a
   *   denial) undecidable.
   * - Failures are wrapped in `PluginGrantManifestInvalidError` so C4 has a
   *   grant-domain error to map — an invalid stored manifest is corrupted
   *   server state, never a caller mistake.
   *
   * The manifest's slug and version are additionally cross-checked against
   * the `Plugin` row. Slug: the canonical envelope is expanded from the
   * manifest, so on drift a decision could resolve against ANOTHER plugin's
   * `PluginPermission` catalog row — exactly the cross-namespace grant the
   * namespacing is meant to make impossible. Version: the row is stamped
   * with `Plugin.version` while the checks come from the JSON, so drift
   * would record consent against a version the shown permissions did not
   * come from, making the escalation comparison meaningless.
   */
  private resolveRequestedCheck(plugin: Plugin, permissionSlug: string): NormalizedPermissionRequest {
    let validated: PluginManifestValidationResult;

    try {
      validated = validatePluginManifest(plugin.manifestJson, {
        bgeVersion: this.options.bgeVersion,
        defaultLocale: this.options.defaultLocale,
        enforceBgeCompat: false,
      });
    } catch (err) {
      if (err instanceof PluginManifestValidationError) {
        throw new PluginGrantManifestInvalidError(plugin.slug, 'stored manifest failed re-validation', err.issues);
      }

      throw err;
    }

    if (validated.manifest.slug !== plugin.slug) {
      throw new PluginGrantManifestInvalidError(
        plugin.slug,
        `manifest slug '${validated.manifest.slug}' does not match the plugin row — canonical permission slugs would resolve against another plugin's catalog`,
      );
    }

    if (validated.manifest.version !== plugin.version) {
      throw new PluginGrantManifestInvalidError(
        plugin.slug,
        `manifest version '${validated.manifest.version}' does not match the plugin row's '${plugin.version}' — the row is stamped with the column while the checks come from the JSON, so the two must agree for escalation comparison to mean anything`,
      );
    }

    const check = validated.permissionChecks.find((candidate) => candidate.canonicalSlug === permissionSlug);

    if (check === undefined) {
      throw new PluginGrantUnknownPermissionError(
        plugin.slug,
        permissionSlug,
        'not requested by the manifest (decisions address canonical slugs: plugin|<slug>|<bare> or a core slug)',
      );
    }

    return check;
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

    return permission.riskLevel;
  }

  private async assertDeciderAuthority(
    input: PluginGrantDecisionInput,
    plugin: Plugin,
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
        if (input.deciderId !== scopeId) {
          throw new PluginGrantAuthorityError(input.deciderId, 'User-scope consent is decided by the user themself');
        }

        if (!(await this.authority.hasQualifyingHouseholdForPlugin(input.deciderId, plugin.id))) {
          throw new PluginGrantAuthorityError(
            input.deciderId,
            'User-scope consent requires membership in at least one household with the plugin enabled',
          );
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
