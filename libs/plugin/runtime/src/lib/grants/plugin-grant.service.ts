import type { Plugin, PluginGrant, Prisma } from '@bge/database';
import {
  DatabaseService,
  PluginGrantScope,
  PluginGrantStatus,
  retryOnDeadlock,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
} from '@bge/database';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import { parsePluginPermissionSlug } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { grantSnapshot } from '../events/plugin-event-snapshots';
import { PluginGrantCreatedEvent, PluginGrantRejectedEvent } from '../events/plugin.events';
import { bindManifest, classifyManifestMove, type ClaimedPluginRow } from '../manifest/manifest-move';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from './consent-scope.map';
import {
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantManifestInvalidError,
  PluginGrantPluginChangedError,
  PluginGrantPluginNotFoundError,
  PluginGrantPluginTombstonedError,
  PluginGrantRequiredDenialError,
  PluginGrantUnknownPermissionError,
} from './grant.errors';
import { isPluginAdministrationSlug } from './plugin-admin-permissions';
import { PluginGrantAuthorityService } from './plugin-grant-authority.service';

/** Server-scope consent decisions only, until #1152 replaces them with the operator's acts. */
export interface PluginGrantDecisionInput {
  /** The plugin's slug — the HTTP edge's addressing; the service resolves the row. */
  readonly slug: string;
  /** CANONICAL slug: `plugin|<slug>|<bare>` for plugin-declared permissions, the core slug otherwise. */
  readonly permissionSlug: string;
  readonly status: PluginGrantStatus;
  /** The consenting server admin — authority is verified, never assumed. */
  readonly deciderId: string;
}

export interface PluginGrantDecisionResult {
  readonly grant: PluginGrant;
  /** False when the decision was an exact re-statement (idempotent, no write, no event). */
  readonly changed: boolean;
}

/**
 * The server's consent decisions (#59 Phase C1): grant or deny one
 * permission the active manifest requests at server consent scope, with
 * grant-time authority verification. Household and user consent decisions,
 * and the unit enablements a switch-on creates, are recorded by consent acts
 * in `PluginConsentActService` (#1150); #1152 moves the server's decisions
 * onto the operator's acts as well.
 *
 * Nothing here revokes consent when a member leaves, loses a role or is
 * deleted: a consent decision belongs to the unit and survives the person
 * who made it (#1150).
 *
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
  constructor(
    private readonly db: DatabaseService,
    private readonly authority: PluginGrantAuthorityService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /**
   * Record a server consent decision for one (plugin, permission). Upsert
   * semantics on the unique quadruple: polarity flips update the row in
   * place; an exact re-statement (same status and risk) is a no-op — no
   * write, no event.
   *
   * A decision writes one grant row and nothing else: it takes no household
   * lock and writes no unit enablement (#1150). A permission the manifest
   * requests at household or user consent scope is refused with the scope
   * mismatch, since a consent act records it.
   */
  async decide(input: PluginGrantDecisionInput): Promise<PluginGrantDecisionResult> {
    const initiatedAt = new Date();

    type DecisionOutcome =
      | { readonly unchanged: true; readonly grant: PluginGrant }
      | {
          readonly unchanged: false;
          readonly before: PluginGrant | null;
          readonly after: PluginGrant;
          readonly manifestVersion: string;
        };

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

      this.assertServerScope(check);

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

      await this.assertServerAdmin(input.deciderId);

      const uniqueWhere = {
        pluginId_scopeType_scopeId_permissionSlug: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Server,
          scopeId: SERVER_SCOPE_SENTINEL,
          permissionSlug: check.canonicalSlug,
        },
      };

      return this.db.$transaction(async (tx): Promise<DecisionOutcome> => {
        // The plugin row, claimed first and shared (#398), then the grant
        // row: a server decision takes nothing else, no household lock and no
        // unit-scope advisory key, because it writes no unit enablement
        // (#1150). The claim's first job is WHERE the lock lands. Every INSERT
        // into `plugin_grants` takes `FOR KEY SHARE` on this row through the
        // FK, and RI checks are AFTER ROW triggers, so that lock arrives only
        // once the grant tuple is already written: the upsert below would
        // otherwise take the plugin row LAST and invert the total order plugin
        // row → grant row. Activation follows that order: its plugin row
        // `FOR UPDATE`, then its server grant rows `FOR UPDATE`. Against
        // activation that inversion is a cycle rather than a queue, and the
        // loser rendered an untyped 500 (#398). Claiming here makes this
        // transaction block BEFORE it writes the grant tuple, so nothing can be
        // waiting on that tuple while this transaction waits on the plugin row.
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

        if (existing !== null && existing.status === input.status && existing.decidedRiskLevel === decidedRiskLevel) {
          return { unchanged: true, grant: existing };
        }

        const decisionFields = {
          status: input.status,
          decidedById: input.deciderId,
          decidedAt: initiatedAt,
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
            scopeType: PluginGrantScope.Server,
            scopeId: SERVER_SCOPE_SENTINEL,
            permissionSlug: check.canonicalSlug,
            ...decisionFields,
          },
          update: decisionFields,
        });

        return { unchanged: false, before: existing, after: written, manifestVersion: plugin.version };
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
      outcome.before === null ? null : grantSnapshot(outcome.before),
      grantSnapshot(outcome.after),
      // The row no longer stores the manifest version, so the event states
      // the one this decision was made against (#1150).
      { manifestVersion: outcome.manifestVersion, actId: null },
      initiatedAt,
    );
    this.emitter.emit(EventClass.eventName, event);

    return { grant: outcome.after, changed: true };
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

  /**
   * A permission the manifest requests at household or user consent scope is
   * decided by a consent act (#1150), never here: refused before the
   * transaction, with the scope it is consented at.
   */
  private assertServerScope(check: NormalizedPermissionRequest): void {
    const expected = CONSENT_SCOPE_TO_GRANT_SCOPE[check.consentScope];

    if (expected !== PluginGrantScope.Server) {
      throw new PluginGrantConsentScopeMismatchError(check.canonicalSlug, expected, PluginGrantScope.Server);
    }
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

    // No unit-boundedness check (#60, #591) here: server consent is
    // server-wide authority. A unit-scope consent decision is a consent act
    // (#1150), and a permission that cannot bind its unit is refused at
    // install by the consent gates and confers nothing on the read path.

    return permission.riskLevel;
  }

  private async assertServerAdmin(deciderId: string): Promise<void> {
    if (!(await this.authority.isServerAdmin(deciderId))) {
      throw new PluginGrantAuthorityError(deciderId, 'Server-scope consent requires a server admin');
    }
  }
}
