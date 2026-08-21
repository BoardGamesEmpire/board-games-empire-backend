import type { Plugin, PluginGrant, Prisma } from '@bge/database';
import {
  DatabaseService,
  hasBoundingConditions,
  PluginGrantScope,
  PluginGrantStatus,
  riskCovers,
  RiskLevel,
  SERVER_SCOPE_SENTINEL,
} from '@bge/database';
import type { NormalizedPermissionRequest, PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { parsePluginPermissionSlug } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PluginGrantRevocationReason } from '../events/plugin.events';
import {
  HouseholdPluginUnitDisabledEvent,
  HouseholdPluginUnitEnabledEvent,
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  PluginGrantRevokedEvent,
  UserPluginUnitDisabledEvent,
  UserPluginUnitEnabledEvent,
} from '../events/plugin.events';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import { CONSENT_SCOPE_TO_GRANT_SCOPE } from './consent-scope.map';
import {
  PluginGrantAuthorityError,
  PluginGrantConsentScopeMismatchError,
  PluginGrantExclusionError,
  PluginGrantManifestInvalidError,
  PluginGrantPluginNotFoundError,
  PluginGrantPluginTombstonedError,
  PluginGrantRequiredDenialError,
  PluginGrantScopeIdError,
  PluginGrantScopeNotRevocableError,
  PluginGrantUnknownPermissionError,
} from './grant.errors';
import { isPluginAdministrationSlug } from './plugin-admin-permissions';
import { PluginGrantAuthorityService } from './plugin-grant-authority.service';
import { lockHouseholdUnitScope, lockUserUnitScope } from './unit-scope-lock';

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

/** The unit-row columns every mirror pass locks, reads, and snapshots. */
interface LockedUnitRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly suspendedForConsent: boolean;
}

/** The same row as `$queryRaw` hands it back: the mapped snake_case columns, unconverted. */
interface LockedUnitSqlRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly suspended_for_consent: boolean;
}

/** A unit the suspend pass flipped, with the full debt the event names. */
interface SuspendedUnitState {
  readonly unit: LockedUnitRow;
  readonly outstanding: readonly string[];
}

const toLockedUnit = (rows: readonly LockedUnitSqlRow[]): LockedUnitRow | null => {
  const row = rows[0];

  return row === undefined
    ? null
    : { id: row.id, enabled: row.enabled, suspendedForConsent: row.suspended_for_consent };
};

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
    const plugin = await this.loadPlugin(input.slug);
    const { check, validated } = this.resolveRequestedCheck(plugin, input.permissionSlug);

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
      | {
          readonly unchanged: false;
          readonly before: PluginGrant | null;
          readonly after: PluginGrant;
          readonly suspension: SuspendedUnitState | null;
        };

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

      // The pre-transaction D-AV judgment cannot order itself against a
      // concurrent update activation: it read the plugin row BEFORE this
      // transaction, and #356's FOR UPDATE only serializes the activation
      // against decisions that COMMIT first — a decide() already past its
      // judgment would just block on the row lock and then write. Re-judge
      // HERE, after the upsert acquired the grant-row lock (so any
      // activation that got there first has committed and is visible, and
      // any activation arriving later blocks until this transaction
      // resolves and then refuses over the denial it sees). The throw takes
      // the write back with it.
      if (input.status === PluginGrantStatus.Denied && check.consentScope === 'server') {
        await this.assertDenialStillLegal(tx, plugin, check.canonicalSlug);
      }

      // The suspend half of the unit mirror rides the decision transaction
      // (#322, PR #359 round 3): recording a required denial while failing
      // to suspend the unit is fail-OPEN — the endpoint reports success and
      // the plugin keeps serving after consent was withdrawn, and nothing
      // in the tree retries a swallowed mirror (the caller got its 200).
      // Both-or-neither: a suspension that cannot be written takes the
      // denial back with it, and the caller retries the whole decision.
      // The lock order this introduces is the same for every decide() —
      // grant row (the upsert above), then unit row — and activation never
      // lock-waits on unit-scope grant rows, so no cycle exists. The
      // re-enable direction deliberately keeps its own transaction and
      // never-throw posture: failing to CLEAR a suspension is fail-closed.
      let suspension: SuspendedUnitState | null = null;

      if (input.status === PluginGrantStatus.Denied && check.required) {
        if (input.scopeType === PluginGrantScope.Household) {
          suspension = await this.suspendHouseholdUnit(
            tx,
            plugin,
            validated,
            scopeId,
            check.canonicalSlug,
            initiatedAt,
          );
        } else if (input.scopeType === PluginGrantScope.User) {
          suspension = await this.suspendUserUnit(tx, plugin, validated, scopeId, check.canonicalSlug, initiatedAt);
        }
      }

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
      //
      // Born suspended over an existing refusal (#322, PR #359 round 3):
      // before this row exists, its ABSENCE is what keeps a unit with a
      // durably Denied required check out of service — a rowless unit does
      // not serve. Creating the anchor unsuspended would put that unit IN
      // service the moment any other grant lands, without the outstanding
      // predicate ever being consulted: the re-enable pass keys on
      // suspended rows, and this one is brand new. So the row is born with
      // the state the mirror would otherwise owe it. Denied specifically,
      // never merely pending — a unit working through its initial consent
      // set is legitimately enabled; only an explicit refusal contradicts
      // serving. A concurrent flip of that denial commits either before
      // this read (born unsuspended, correct) or after it, and the flip's
      // own re-enable pass then clears the suspension it finds — BOTH of
      // those orderings exist only because the advisory lock below
      // serializes this path against every other writer of this unit's
      // state; without it, two overlapping transactions are each invisible
      // to the other (see lockUserUnitScope).
      if (input.status === PluginGrantStatus.Granted && input.scopeType === PluginGrantScope.User) {
        await lockUserUnitScope(tx, scopeId, plugin.id);

        const otherRequiredSlugs = validated.permissionChecks
          .filter(
            (candidate) =>
              candidate.consentScope === 'user' &&
              candidate.required &&
              candidate.canonicalSlug !== check.canonicalSlug,
          )
          .map((candidate) => candidate.canonicalSlug);
        const deniedRequired =
          otherRequiredSlugs.length === 0
            ? 0
            : await tx.pluginGrant.count({
                where: {
                  pluginId: plugin.id,
                  scopeType: PluginGrantScope.User,
                  scopeId,
                  status: PluginGrantStatus.Denied,
                  permissionSlug: { in: otherRequiredSlugs },
                },
              });
        const bornSuspended = deniedRequired > 0;

        await tx.userPlugin.upsert({
          where: { userId_pluginId: { userId: scopeId, pluginId: plugin.id } },
          create: {
            userId: scopeId,
            pluginId: plugin.id,
            suspendedForConsent: bornSuspended,
            suspendedAt: bornSuspended ? initiatedAt : null,
          },
          update: {},
        });
      }

      return { unchanged: false, before: existing, after: written, suspension };
    });

    // An idempotent re-statement still reconciles the unit: the mirror
    // passes are the only writers of `suspendedForConsent` on the decision
    // path and they are deliberately non-fatal, so a decision whose mirror
    // failed — or never ran, if the process died between commit and
    // mirror — leaves the unit stale, and the obvious repair (re-POSTing
    // the same decision) used to return here before reaching them. Both
    // directions are idempotent and emit only on a real flip, so running
    // them for an unchanged decision reconciles without inventing a
    // transition.
    if (outcome.unchanged) {
      await this.reconcileUnitState(plugin, validated, input, scopeId, check, initiatedAt);

      return { grant: outcome.grant, changed: false };
    }

    const EventClass = input.status === PluginGrantStatus.Granted ? PluginGrantCreatedEvent : PluginGrantRejectedEvent;
    const event = new EventClass(
      outcome.before === null ? null : this.snapshot(outcome.before),
      this.snapshot(outcome.after),
      initiatedAt,
    );
    this.emitter.emit(EventClass.eventName, event);

    if (input.status === PluginGrantStatus.Granted) {
      // Late acceptance re-enables: a unit-scope `Granted` decision is the
      // only transition that can clear a consent suspension, so the check
      // rides the decision itself rather than a sweeper (#225).
      if (input.scopeType === PluginGrantScope.Household) {
        await this.maybeReenableSuspendedHousehold(plugin, validated, scopeId, check, initiatedAt);
      } else if (input.scopeType === PluginGrantScope.User) {
        await this.maybeReenableSuspendedUser(plugin, validated, scopeId, check, initiatedAt);
      }
    } else if (outcome.suspension !== null) {
      // The suspension committed WITH the denial; only the announcement
      // waited for the commit, like every other event on this path.
      if (input.scopeType === PluginGrantScope.Household) {
        this.emitHouseholdSuspension(plugin, scopeId, outcome.suspension, initiatedAt);
      } else if (input.scopeType === PluginGrantScope.User) {
        this.emitUserSuspension(plugin, scopeId, outcome.suspension, initiatedAt);
      }
    }

    return { grant: outcome.after, changed: true };
  }

  /**
   * Bring the unit row into line with a RE-STATED decision — the repair
   * path. A changed decision keeps its unit state consistent on its own:
   * the suspend half commits inside the decision transaction, and the
   * re-enable half runs right after the commit. But the re-enable half is
   * deliberately non-fatal, so a decision whose clear failed leaves the
   * unit stale with the caller already holding a 200 — and re-POSTing the
   * same decision is the one repair a caller can reach. Both directions
   * are idempotent and emit only on a real flip, so re-running them here
   * reconciles without inventing a transition.
   *
   * Deliberately a delta-scoped mirror PAIR and not a blind reconcile of
   * the outstanding set against the row: an optional denial never suspends
   * — features bound to it degrade per-check, the durable denial preserved
   * — and a unit legitimately enabled while some OTHER requirement is
   * still pending is not this decision's to suspend. Reconciling on
   * `outstanding` alone would suspend every unit still working through its
   * initial pending set.
   *
   * Same shape at both unit scopes (#225).
   */
  private async reconcileUnitState(
    plugin: Plugin,
    validated: PluginManifestValidationResult,
    input: PluginGrantDecisionInput,
    scopeId: string,
    check: NormalizedPermissionRequest,
    initiatedAt: Date,
  ): Promise<void> {
    if (input.status === PluginGrantStatus.Granted) {
      if (input.scopeType === PluginGrantScope.Household) {
        await this.maybeReenableSuspendedHousehold(plugin, validated, scopeId, check, initiatedAt);
      } else if (input.scopeType === PluginGrantScope.User) {
        await this.maybeReenableSuspendedUser(plugin, validated, scopeId, check, initiatedAt);
      }
    } else if (check.required) {
      if (input.scopeType === PluginGrantScope.Household) {
        await this.maybeSuspendHousehold(plugin, validated, scopeId, check.canonicalSlug, initiatedAt);
      } else if (input.scopeType === PluginGrantScope.User) {
        await this.maybeSuspendUser(plugin, validated, scopeId, check.canonicalSlug, initiatedAt);
      }
    }
  }

  /**
   * Clear a unit's `suspendedForConsent` once the household's consent state
   * satisfies the ACTIVE manifest, and emit `plugin.unit_enabled`
   * (#59). Evaluated on every Household grant rather than only
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
   * Read, predicate, and write all sit in ONE transaction holding the unit
   * row's lock, because the predicate reads a DIFFERENT table than the row
   * it writes. Unlocked, this pass and its suspend mirror each compute
   * against grants the other is about to change, and the guarded write then
   * commits a conclusion that was already stale — a fully granted unit left
   * suspended, or a unit left serving under a denial it just recorded. The
   * guard cannot catch that: it proves only that nobody else flipped the
   * same column, not that the premise still holds.
   *
   * Failures are logged, never thrown: the decision above is already
   * committed and emitted, and making a caller retry a recorded consent
   * because the re-enable bookkeeping hiccuped would be worse than a unit
   * that stays suspended until a decision re-runs this check — which now
   * includes re-stating the same decision.
   */
  private async maybeReenableSuspendedHousehold(
    plugin: Plugin,
    validated: PluginManifestValidationResult,
    householdId: string,
    check: NormalizedPermissionRequest,
    initiatedAt: Date,
  ): Promise<void> {
    try {
      const householdChecks = validated.permissionChecks.filter((candidate) => candidate.consentScope === 'household');

      const cleared = await this.db.$transaction(async (tx) => {
        // The scope lock, not just the row lock (#323): the household
        // enable endpoint creates rows near decisions now, and an uncommitted
        // creation is invisible to the row lock query — waiting on the
        // advisory key is what makes a born-suspended row visible here at all.
        await lockHouseholdUnitScope(tx, householdId, plugin.id);

        const unit = await this.lockHouseholdUnit(tx, householdId, plugin.id);

        if (unit === null || !unit.suspendedForConsent) {
          return null;
        }

        if (
          householdChecks.length > 0 &&
          !(await this.unitConsentSatisfied(tx, plugin, PluginGrantScope.Household, householdId, householdChecks))
        ) {
          return null;
        }

        // Guarded update, not a blind write: belt-and-braces under the lock
        // for the one writer that does not take it (activation suspends
        // inside its own transaction), and only the writer that actually
        // flipped the row emits.
        const flipped = await tx.householdPlugin.updateMany({
          where: { id: unit.id, suspendedForConsent: true },
          data: { suspendedForConsent: false, suspendedAt: null },
        });

        return flipped.count === 1 ? unit : null;
      });

      if (cleared === null) {
        return;
      }

      // Emitted after the transaction commits, the same discipline the
      // decision above follows: a listener must never see a transition the
      // database has not accepted.
      const snapshot = (suspendedForConsent: boolean) => ({
        id: cleared.id,
        householdId,
        pluginId: plugin.id,
        enabled: cleared.enabled,
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
          `committed; the unit stays suspended until a decision re-runs this check: ${
            err instanceof Error ? err.message : err
          }`,
      );
    }
  }

  /**
   * The user-scope mirror of the household re-enable above (#225): same
   * predicate, same locked transaction, same never-throw posture — the two
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
      const userChecks = validated.permissionChecks.filter((candidate) => candidate.consentScope === 'user');

      const cleared = await this.db.$transaction(async (tx) => {
        // The scope lock, not just the row lock: a born-suspended anchor
        // this pass should clear may not be COMMITTED yet when a
        // concurrent flip's re-enable runs — waiting on the advisory key
        // is what makes the anchor visible here at all.
        await lockUserUnitScope(tx, userId, plugin.id);

        const unit = await this.lockUserUnit(tx, userId, plugin.id);

        if (unit === null || !unit.suspendedForConsent) {
          return null;
        }

        if (
          userChecks.length > 0 &&
          !(await this.unitConsentSatisfied(tx, plugin, PluginGrantScope.User, userId, userChecks))
        ) {
          return null;
        }

        const flipped = await tx.userPlugin.updateMany({
          where: { id: unit.id, suspendedForConsent: true },
          data: { suspendedForConsent: false, suspendedAt: null },
        });

        return flipped.count === 1 ? unit : null;
      });

      if (cleared === null) {
        return;
      }

      const snapshot = (suspendedForConsent: boolean) => ({
        id: cleared.id,
        userId,
        pluginId: plugin.id,
        enabled: cleared.enabled,
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
          `committed; the unit stays suspended until a decision re-runs this check: ${
            err instanceof Error ? err.message : err
          }`,
      );
    }
  }

  /**
   * The suspend mirror of {@link maybeReenableSuspendedHousehold} (#322):
   * after a `Denied` decision on a REQUIRED household-scope check, set
   * `suspendedForConsent` on the unit — but only while THAT check is still
   * outstanding. Same guarded write (only the writer that flips the row
   * emits — belt-and-braces under the lock, for activation's pass, which
   * does not take it), and the unit heals through exactly the predicate
   * late acceptance runs in reverse, so the pair cannot oscillate.
   *
   * Runs on the CALLER's transaction: the decision path passes its own, so
   * the flip commits — and fails — WITH the denial; the reconcile path
   * wraps it in a fresh one. Returns what flipped so the caller can emit
   * after ITS commit — announcing in here would let a listener see a
   * transition the database later rolled back. The event names the FULL
   * outstanding list, not just the denied slug, matching the update
   * service's suspension events: the lifecycle row is the durable "why".
   */
  private async suspendHouseholdUnit(
    tx: Prisma.TransactionClient,
    plugin: Plugin,
    validated: PluginManifestValidationResult,
    householdId: string,
    deniedSlug: string,
    initiatedAt: Date,
  ): Promise<SuspendedUnitState | null> {
    // Advisory before the row lock (#323): the enable endpoint
    // creates household rows near decisions now, and this pass must wait
    // out an uncommitted creation rather than read "no row" past it —
    // the same suffix of the total order the user-scope twin takes.
    await lockHouseholdUnitScope(tx, householdId, plugin.id);

    const householdChecks = validated.permissionChecks.filter((candidate) => candidate.consentScope === 'household');
    const unit = await this.lockHouseholdUnit(tx, householdId, plugin.id);

    if (unit === null || unit.suspendedForConsent) {
      return null;
    }

    const outstanding = await this.outstandingUnitSlugs(
      tx,
      plugin,
      PluginGrantScope.Household,
      householdId,
      householdChecks,
    );

    // The delta-scoping, ENFORCED rather than assumed. Reading the full
    // outstanding set and asking only whether it is non-empty would let
    // this pass suspend over some OTHER requirement that is merely still
    // pending — exactly the state the mirror is documented NOT to act on:
    // a unit working through its initial consent set is legitimately
    // enabled. On the decision path the denied slug is outstanding by
    // construction (its row was written Denied in this very transaction);
    // the guard is load-bearing on the reconcile path, where a `Granted`
    // flip may have committed since the denial being re-stated.
    if (!outstanding.includes(deniedSlug)) {
      return null;
    }

    const flipped = await tx.householdPlugin.updateMany({
      where: { id: unit.id, suspendedForConsent: false },
      data: { suspendedForConsent: true, suspendedAt: initiatedAt },
    });

    return flipped.count === 1 ? { unit, outstanding } : null;
  }

  /** Post-commit announcement for {@link suspendHouseholdUnit}'s flip. */
  private emitHouseholdSuspension(
    plugin: Plugin,
    householdId: string,
    suspension: SuspendedUnitState,
    initiatedAt: Date,
  ): void {
    const { unit, outstanding } = suspension;
    const snapshot = (suspendedForConsent: boolean) => ({
      id: unit.id,
      householdId,
      pluginId: plugin.id,
      enabled: unit.enabled,
      suspendedForConsent,
    });

    this.emitter.emit(
      HouseholdPluginUnitDisabledEvent.eventName,
      new HouseholdPluginUnitDisabledEvent(snapshot(false), snapshot(true), outstanding, plugin.version, initiatedAt),
    );
    this.logger.warn(
      `Household '${householdId}' suspended for plugin '${plugin.slug}': a denial left required consent ` +
        `outstanding (${outstanding.join(', ')})`,
    );
  }

  /**
   * Reconcile-path wrapper: own transaction, never-throw — here the denial
   * is already durable and this re-run IS the retry, so failing the caller
   * again buys nothing a further re-statement cannot.
   */
  private async maybeSuspendHousehold(
    plugin: Plugin,
    validated: PluginManifestValidationResult,
    householdId: string,
    deniedSlug: string,
    initiatedAt: Date,
  ): Promise<void> {
    try {
      const suspended = await this.db.$transaction((tx) =>
        this.suspendHouseholdUnit(tx, plugin, validated, householdId, deniedSlug, initiatedAt),
      );

      if (suspended !== null) {
        this.emitHouseholdSuspension(plugin, householdId, suspended, initiatedAt);
      }
    } catch (err) {
      this.logger.error(
        `Suspension check failed for household '${householdId}' / plugin '${plugin.slug}' — the grant decision is ` +
          `committed; the unit stays unsuspended until a decision re-runs this check: ${
            err instanceof Error ? err.message : err
          }`,
      );
    }
  }

  /**
   * The user-scope mirror of the household suspension above — the same
   * deliberate sibling-duplication shape as the re-enable pair (#225): the
   * delegates and snapshot types differ, and the duplication is the
   * readable kind. Same caller's-transaction contract as
   * {@link suspendHouseholdUnit}.
   */
  private async suspendUserUnit(
    tx: Prisma.TransactionClient,
    plugin: Plugin,
    validated: PluginManifestValidationResult,
    userId: string,
    deniedSlug: string,
    initiatedAt: Date,
  ): Promise<SuspendedUnitState | null> {
    await lockUserUnitScope(tx, userId, plugin.id);

    const userChecks = validated.permissionChecks.filter((candidate) => candidate.consentScope === 'user');
    const unit = await this.lockUserUnit(tx, userId, plugin.id);

    if (unit === null || unit.suspendedForConsent) {
      return null;
    }

    const outstanding = await this.outstandingUnitSlugs(tx, plugin, PluginGrantScope.User, userId, userChecks);

    if (!outstanding.includes(deniedSlug)) {
      return null;
    }

    const flipped = await tx.userPlugin.updateMany({
      where: { id: unit.id, suspendedForConsent: false },
      data: { suspendedForConsent: true, suspendedAt: initiatedAt },
    });

    return flipped.count === 1 ? { unit, outstanding } : null;
  }

  /** Post-commit announcement for {@link suspendUserUnit}'s flip. */
  private emitUserSuspension(plugin: Plugin, userId: string, suspension: SuspendedUnitState, initiatedAt: Date): void {
    const { unit, outstanding } = suspension;
    const snapshot = (suspendedForConsent: boolean) => ({
      id: unit.id,
      userId,
      pluginId: plugin.id,
      enabled: unit.enabled,
      suspendedForConsent,
    });

    this.emitter.emit(
      UserPluginUnitDisabledEvent.eventName,
      new UserPluginUnitDisabledEvent(snapshot(false), snapshot(true), outstanding, plugin.version, initiatedAt),
    );
    this.logger.warn(
      `User '${userId}' suspended for plugin '${plugin.slug}': a denial left required consent ` +
        `outstanding (${outstanding.join(', ')})`,
    );
  }

  /** Reconcile-path wrapper — see {@link maybeSuspendHousehold}. */
  private async maybeSuspendUser(
    plugin: Plugin,
    validated: PluginManifestValidationResult,
    userId: string,
    deniedSlug: string,
    initiatedAt: Date,
  ): Promise<void> {
    try {
      const suspended = await this.db.$transaction((tx) =>
        this.suspendUserUnit(tx, plugin, validated, userId, deniedSlug, initiatedAt),
      );

      if (suspended !== null) {
        this.emitUserSuspension(plugin, userId, suspended, initiatedAt);
      }
    } catch (err) {
      this.logger.error(
        `Suspension check failed for user '${userId}' / plugin '${plugin.slug}' — the grant decision is ` +
          `committed; the unit stays unsuspended until a decision re-runs this check: ${
            err instanceof Error ? err.message : err
          }`,
      );
    }
  }

  /**
   * Take the household unit row's lock for the rest of `tx`, returning the
   * fields the mirror passes read. Raw SQL because Prisma exposes no
   * row-lock API (#356 took the same route for `plugin_grants`), and an
   * unqualified table name so the per-worker schema's `search_path`
   * resolves it. A missing row is a household that never enabled the
   * plugin — nothing to lock and nothing to mirror.
   */
  private async lockHouseholdUnit(
    tx: Prisma.TransactionClient,
    householdId: string,
    pluginId: string,
  ): Promise<LockedUnitRow | null> {
    const rows = await tx.$queryRaw<LockedUnitSqlRow[]>`
      SELECT id, enabled, suspended_for_consent
      FROM household_plugins
      WHERE household_id = ${householdId} AND plugin_id = ${pluginId}
      FOR UPDATE`;

    return toLockedUnit(rows);
  }

  /** The user-scope sibling of {@link lockHouseholdUnit}. */
  private async lockUserUnit(
    tx: Prisma.TransactionClient,
    userId: string,
    pluginId: string,
  ): Promise<LockedUnitRow | null> {
    const rows = await tx.$queryRaw<LockedUnitSqlRow[]>`
      SELECT id, enabled, suspended_for_consent
      FROM user_plugins
      WHERE user_id = ${userId} AND plugin_id = ${pluginId}
      FOR UPDATE`;

    return toLockedUnit(rows);
  }

  /**
   * Does this unit's consent state satisfy every check of the active
   * manifest at its consent scope? Required checks need a `Granted` row;
   * any check that HAS one needs its recorded risk to still cover the
   * catalog's current classification. Mirrors the update service's
   * suspension predicate exactly — the two must agree or suspensions
   * bounce. Scope-parametric (#225): callers pass the checks pre-filtered
   * to the matching `consentScope`, and the transaction that holds the unit
   * row's lock, so the answer cannot be stale by the time it is written.
   */
  private async unitConsentSatisfied(
    client: Prisma.TransactionClient,
    plugin: Plugin,
    scopeType: Exclude<PluginGrantScope, typeof PluginGrantScope.Server>,
    scopeId: string,
    unitChecks: readonly NormalizedPermissionRequest[],
  ): Promise<boolean> {
    return (await this.outstandingUnitSlugs(client, plugin, scopeType, scopeId, unitChecks)).length === 0;
  }

  /**
   * The slugs standing between this unit and a satisfied consent state:
   * required checks without a `Granted` row, plus any granted check whose
   * recorded risk no longer covers today's classification. One computation
   * behind BOTH the late-acceptance re-enable and the denial suspension
   * (D-BQ) — deriving them separately is how a unit oscillates.
   */
  private async outstandingUnitSlugs(
    client: Prisma.TransactionClient,
    plugin: Plugin,
    scopeType: Exclude<PluginGrantScope, typeof PluginGrantScope.Server>,
    scopeId: string,
    unitChecks: readonly NormalizedPermissionRequest[],
  ): Promise<readonly string[]> {
    const granted = await client.pluginGrant.findMany({
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
        : await client.permission.findMany({
            where: { slug: { in: coreSlugs } },
            select: { slug: true, riskLevel: true },
          });
    const currentRiskBySlug = new Map(coreRisks.map((row) => [row.slug, row.riskLevel]));

    const outstanding: string[] = [];

    for (const check of unitChecks) {
      const decidedRiskLevel = decidedBySlug.get(check.canonicalSlug);

      if (decidedRiskLevel === undefined) {
        if (check.required) {
          outstanding.push(check.canonicalSlug);
        }

        continue;
      }

      const currentRiskLevel =
        check.origin === 'plugin' ? RiskLevel.Low : (currentRiskBySlug.get(check.canonicalSlug) ?? RiskLevel.Low);

      if (!riskCovers(decidedRiskLevel, currentRiskLevel)) {
        outstanding.push(check.canonicalSlug);
      }
    }

    return outstanding;
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

  /**
   * The in-transaction half of D-AV (#356's mirror image): re-read the
   * plugin row AFTER the grant upsert and re-judge the denial against the
   * manifest that is active NOW. The upsert serialized this transaction
   * against any activation touching the same grant row, so a version that
   * moved since the pre-transaction judgment is visible here — and a
   * denial the NEW manifest's required set forbids rolls the whole write
   * back with the same typed error the front door raises. A version that
   * has not moved was already judged; activation always changes the
   * version (same-version updates are refused at stage), so equality is a
   * sound skip.
   */
  private async assertDenialStillLegal(
    tx: Prisma.TransactionClient,
    plugin: Plugin,
    canonicalSlug: string,
  ): Promise<void> {
    const current = await tx.plugin.findUnique({
      where: { id: plugin.id },
      select: { slug: true, version: true, manifestJson: true, uninstalledAt: true },
    });

    if (current === null) {
      throw new PluginGrantPluginNotFoundError(plugin.slug);
    }

    // An uninstall that landed mid-decision: same answer the front door
    // gives, and the rollback keeps the tombstone's grant purge clean.
    if (current.uninstalledAt !== null) {
      throw new PluginGrantPluginTombstonedError(plugin.slug, current.uninstalledAt);
    }

    if (current.version === plugin.version) {
      return;
    }

    const revalidated = revalidateStoredManifest(
      { slug: current.slug, version: current.version, manifestJson: current.manifestJson },
      this.options,
      (pluginSlug, detail, issues) => new PluginGrantManifestInvalidError(pluginSlug, detail, issues),
    );
    const nowCheck = revalidated.permissionChecks.find((candidate) => candidate.canonicalSlug === canonicalSlug);

    // A check the new manifest dropped is not a contradiction — the row
    // becomes a durable denial of nothing, exactly what a removed-declare
    // cleanup or the next decision will resolve.
    if (nowCheck !== undefined && nowCheck.required && nowCheck.consentScope === 'server') {
      throw new PluginGrantRequiredDenialError(plugin.slug, canonicalSlug);
    }
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
