import type { Plugin, PluginGrant, Prisma } from '@bge/database';
import {
  bindsConsentUnit,
  CONSENT_UNIT_BINDING_REFUSAL,
  DatabaseService,
  lockLiveHousehold,
  PluginGrantScope,
  PluginGrantStatus,
  retryOnDeadlock,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
} from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { parsePluginPermissionSlug } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PluginGrantRevocationReason } from '../events/plugin.events';
import { PluginGrantCreatedEvent, PluginGrantRejectedEvent, PluginGrantRevokedEvent } from '../events/plugin.events';
import { bindManifest, classifyManifestMove, type ClaimedPluginRow } from '../manifest/manifest-move';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from './consent-scope.map';
import {
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantHouseholdNotFoundError,
  PluginGrantManifestInvalidError,
  PluginGrantPluginChangedError,
  PluginGrantPluginNotFoundError,
  PluginGrantPluginTombstonedError,
  PluginGrantRequiredDenialError,
  PluginGrantScopeIdError,
  PluginGrantScopeNotRevocableError,
  PluginGrantUnknownPermissionError,
} from './grant.errors';
import { isPluginAdministrationSlug } from './plugin-admin-permissions';
import { PluginGrantAuthorityService } from './plugin-grant-authority.service';
import { lockUserUnitScope } from './unit-scope-lock';

export interface PluginGrantDecisionInput {
  /** The plugin's slug — the HTTP edge's addressing (D-AX/D-BO); the service resolves the row. */
  readonly slug: string;
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
 * the user's unit enablement a first Granted user-scope decision creates
 * (#225), and authority-loss revocation (delete-to-pending, #211).
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
   *
   * A decision writes one grant row and, for a first user grant, the user's
   * unit enablement. What the unit still owes is read, never written: its
   * consent standing is worked out from the grant rows whenever it is
   * needed (#1149). A decision used to mirror that standing onto the unit
   * row, suspending it on a required denial and lifting the suspension on
   * the grant that cleared the last one, and every way that mirror drifted
   * from the grants was a bug: #1061, #1063 and #1147.
   */
  async decide(input: PluginGrantDecisionInput): Promise<PluginGrantDecisionResult> {
    const initiatedAt = new Date();

    type DecisionOutcome =
      | { readonly unchanged: true; readonly grant: PluginGrant }
      | { readonly unchanged: false; readonly before: PluginGrant | null; readonly after: PluginGrant };

    /**
     * The plugin as the request first read it. A deadlock replay judges
     * against this same read rather than reading again (#361).
     */
    let firstRead: Plugin | null = null;

    /**
     * One whole attempt: the gates that judge against the plugin manifest, and
     * the transaction that writes the decision.
     *
     * A plugin manifest move between the read and the transaction is refused,
     * not replayed: the claim below compares the content, and the 409 is how
     * the client learns its consent surface is out of date (#361; the wider
     * window, a screen rendered hours earlier, is #1051).
     *
     * That holds across a deadlock replay too, which is why the plugin is read
     * once per request. A deadlock means a concurrent writer of this plugin row
     * was live, most often an activation (#398). A replay that read again
     * would judge against whatever that writer committed and record consent
     * against a plugin manifest that moved mid-request, with nothing telling
     * the client. Judged against the first read, the replay's claim sees the
     * move and refuses it with the same 409 a request without a deadlock gets.
     * Everything else runs again: the catalog risk and the decider's authority
     * are read fresh, and nothing above the transaction writes.
     */
    const attempt = async (): Promise<DecisionOutcome> => {
      firstRead ??= await this.loadPlugin(input.slug);

      const plugin = firstRead;
      const check = this.resolveRequestedCheck(plugin, input.permissionSlug);

      this.assertScopeCoherence(check, input);

      // D-AV (#322): a denial against a check the ACTIVE manifest requires at
      // server consent scope is refused, not recorded — the decider IS the
      // kill-switch owner, so the honest levers (disable, uninstall) already
      // exist as first-class actions, and recording the contradiction would
      // leave the plugin serving with a permission its author declared
      // load-bearing. `resolveRequestedCheck` resolves against the ACTIVE
      // manifest, so a permission that only a PENDING manifest promotes to
      // required is untouched here: that denial stays legal and blocks at
      // approve instead (D-AB) — an upgrade's rejected permissions never
      // coerce the installed plugin.
      if (input.status === PluginGrantStatus.Denied && check.required && check.consentScope === 'server') {
        throw new PluginGrantRequiredDenialError(plugin.slug, check.canonicalSlug);
      }

      const scopeId = this.normalizeScopeId(input);
      await this.assertDeciderAuthority(input, scopeId);

      const uniqueWhere = {
        pluginId_scopeType_scopeId_permissionSlug: {
          pluginId: plugin.id,
          scopeType: input.scopeType,
          scopeId,
          permissionSlug: check.canonicalSlug,
        },
      };

      return this.db.$transaction(async (tx): Promise<DecisionOutcome> => {
        // A household decision locks its household first (#548). The admin
        // check above ran outside this transaction and took no lock, so a
        // soft-delete can commit in between; this waits out one in flight and
        // refuses one that committed. Ahead of the plugin-row claim because a
        // soft-delete holds the household row while it runs and touches no
        // plugin table, so a decision queued here holds nothing it waits on.
        if (input.scopeType === PluginGrantScope.Household && !(await lockLiveHousehold(tx, scopeId))) {
          throw new PluginGrantHouseholdNotFoundError(scopeId);
        }

        // The plugin row, claimed next and shared (#398). Its first job is
        // WHERE the lock lands. Every INSERT into `plugin_grants` takes
        // `FOR KEY SHARE` on this row through the FK, and RI checks are AFTER
        // ROW triggers, so that lock arrives only once the grant tuple is
        // already written: the upsert below would otherwise take the plugin row
        // LAST and invert the total order plugin row → grant row → advisory →
        // unit enablement that activation's `FOR UPDATE` follows. Against activation
        // that inversion is a cycle rather than a queue, and the loser rendered
        // an untyped 500 (#398). Claiming here makes this transaction block
        // BEFORE it writes the grant tuple, so nothing can be waiting on that
        // tuple while this transaction waits on the plugin row.
        //
        // Its second job is the check that keeps every gate's judgment current
        // (#361). The claim reads the row it locks and compares it with the
        // plugin manifest the gates above were derived from, so a decision that
        // read a plugin manifest an activation or reinstall has since replaced
        // is refused, and the content cannot move again while `FOR SHARE` is
        // held. That makes the pre-transaction judgments, the required-denial
        // rule included, judgments against the current plugin manifest, and no
        // re-read after the write is needed.
        //
        // `FOR SHARE` rather than the FK's weaker `FOR KEY SHARE`: both close
        // the cycle, and the wider mode also excludes the non-key UPDATE that a
        // plugin manifest replacement is. `decide()` never writes this row, so
        // no lock upgrade follows. Raw SQL because Prisma's query API cannot
        // express a row lock; unqualified table name so the search_path
        // (per-worker test schemas) resolves it.
        const claimed = await tx.$queryRaw<
          ClaimedPluginRow[]
        >`SELECT uninstalled_at, version, installed_at, manifest_json = ${bindManifest(plugin.manifestJson)}::jsonb AS manifest_matches
          FROM plugins WHERE id = ${plugin.id} FOR SHARE`;
        const claim = claimed[0];

        if (claim === undefined) {
          throw new PluginGrantPluginNotFoundError(plugin.slug);
        }

        if (claim.uninstalled_at !== null) {
          throw new PluginGrantPluginTombstonedError(plugin.slug, claim.uninstalled_at);
        }

        const moved = classifyManifestMove(claim, plugin);

        if (moved !== null) {
          throw new PluginGrantPluginChangedError(plugin.slug, moved, plugin.version, claim.version);
        }

        // The catalog risk is read under the claim, not before it (#361).
        // Activation deletes the catalog rows of the declares it drops and
        // uninstall deletes them all, and both hold this row exclusively. Read
        // before the claim, the catalog could already reflect a move the claim
        // has yet to report, most of all on a deadlock replay, whose plugin
        // read predates the activation it lost to. The client would get a 422
        // for a permission its consent screen listed instead of the 409 or 410
        // that says the screen is out of date. Under a claim that matched,
        // the catalog is the one the claimed plugin manifest declares, so a
        // missing row is a real inconsistency.
        const decidedRiskLevel = await this.resolveRiskLevel(tx, plugin, check);

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
        // decision ensures the user's unit enablement exists, atomically with
        // the decision — committing consent without the row would leave a
        // user who consented but is not enabled, a state only another
        // decision could heal. The row carries enablement and nothing about
        // consent: the update arm is empty because the row may exist
        // user-disabled and consent never writes `enabled`, and the create
        // arm records no consent state because the unit's consent standing is
        // read from its grant rows (#1149). A Denied decision creates no row:
        // a refusal confers no enablement, and the durable denial already
        // lives on the grant row itself.
        //
        // The scope lock comes first, as it does for every writer of this
        // unit's enablement, the user's own enable toggle included: the row
        // may not exist yet, and the advisory key does (see lockUserUnitScope).
        if (input.status === PluginGrantStatus.Granted && input.scopeType === PluginGrantScope.User) {
          await lockUserUnitScope(tx, scopeId, plugin.id);

          await tx.userPlugin.upsert({
            where: { userId_pluginId: { userId: scopeId, pluginId: plugin.id } },
            create: { userId: scopeId, pluginId: plugin.id },
            update: {},
          });
        }

        return { unchanged: false, before: existing, after: written };
      });
    };

    // Retried once if Postgres picks this attempt as the deadlock victim
    // (D-398-2). Replaying is safe because the abort took the transaction
    // whole — no write outlives it, and the events emit below, after the
    // commit — and bounded at once for the same reason the activation service
    // bounds its P2002 retry: a second deadlock means a contender is sustaining
    // the contention, and the edge renders that as a typed refusal rather than
    // a bare 500. The replay judges against the request's first read, so an
    // activation the deadlock let through is refused by its claim (#361).
    const outcome = await retryOnDeadlock(attempt);

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

  private async loadPlugin(slug: string): Promise<Plugin> {
    const plugin = await this.db.plugin.findUnique({ where: { slug } });

    if (plugin === null) {
      throw new PluginGrantPluginNotFoundError(slug);
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
  private resolveRequestedCheck(plugin: Plugin, permissionSlug: string): NormalizedPermissionRequest {
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
   *
   * `client` is the decision's transaction, called once its plugin-row
   * claim matched (#361).
   */
  private async resolveRiskLevel(
    client: Prisma.TransactionClient,
    plugin: Plugin,
    check: NormalizedPermissionRequest,
  ): Promise<RiskLevel> {
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

      const declared = await client.pluginPermission.findUnique({ where: { slug: check.canonicalSlug } });

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

    // A retired slug (#235) is unknown here on purpose: a unit must not be
    // asked to consent to authority the catalog has withdrawn.
    const permission = await client.permission.findUnique({ where: { slug: check.canonicalSlug, retiredAt: null } });

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

    // Unit-boundedness (#60, #591): a household/user cannot consent to more
    // than its own slice, so below server scope the permission must bind
    // the consenting unit — restrict it to its own id, or be an allowlisted
    // public read. Refused here rather than recorded as a grant the read path
    // would ignore — a decision that can never confer is not a decision, it
    // is a trap for whoever reads the consent screen.
    const scope = CONSENT_SCOPE_TO_GRANT_SCOPE[check.consentScope];

    if (scope !== PluginGrantScope.Server && !bindsConsentUnit(permission, scope)) {
      throw new PluginGrantExclusionError(
        check.canonicalSlug,
        `consented at ${check.consentScope} scope, ${CONSENT_UNIT_BINDING_REFUSAL}; request it at server ` +
          'scope or seed a unit-conditioned variant (#315)',
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
        const standing = await this.authority.householdAdminStanding(input.deciderId, householdId);

        if (standing === 'admin') {
          return;
        }

        // Once the household is deleted, its own admin gets the 404; anyone
        // else keeps the 403 whatever state the household is in, so the
        // refusal says nothing about which households exist.
        if (standing === 'deleted') {
          throw new PluginGrantHouseholdNotFoundError(householdId);
        }

        throw new PluginGrantAuthorityError(
          input.deciderId,
          `Household-scope consent requires an owner/admin membership in household '${householdId}'`,
        );
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
