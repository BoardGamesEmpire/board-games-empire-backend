import { AuditContextService } from '@bge/actor-context';
import type { HouseholdPlugin, Plugin, PluginConsentAct, PluginScope, UserPlugin } from '@bge/database';
import { DatabaseService, lockLiveHousehold, PluginConsentActKind, PluginGrantScope, type Prisma } from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { householdSwitchSnapshot, userSwitchSnapshot } from '../events/plugin-event-snapshots';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginDisabledEvent,
  HouseholdPluginEnabledEvent,
  UserPluginDisabledEvent,
  UserPluginEnabledEvent,
} from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { assertHouseholdAdmin } from '../units/household-admin-assertion';
import { assertHeldConfigSatisfiesGate } from '../units/household-config-gate';
import { assertHouseholdSurface, loadLivingPlugin } from '../units/living-plugin';
import {
  PluginUnitAuthorityError,
  PluginUnitHouseholdNotFoundError,
  PluginUnitManifestError,
  PluginUnitPluginNotFoundError,
  PluginUnitPluginTombstonedError,
} from '../units/unit.errors';
import { planConsentAct } from './consent-act-plan';
import { unitOwnsConsentScope, type ConsentManifestSource } from './consent-classification.types';
import { emitDecisionEvents, type WrittenDecision } from './consent-decision-events';
import { decisionsStand, decisionStands } from './consent-decision-stands';
import {
  PluginConsentActNoUserScopeError,
  PluginConsentActStaleError,
  PluginConsentActUnitOffError,
} from './plugin-consent-act.errors';
import type { ConsentActAnswer, ConsentActKind, ConsentActUnit } from './plugin-consent-act.types';
import { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';
import { writeConsentAct } from './write-consent-act';

export interface ConsentActInput {
  /** The acting user: a household admin for a household unit, the user themself for a user unit. Verified here. */
  readonly actorId: string;
  readonly answers: readonly ConsentActAnswer[];
  readonly locale?: string;
  readonly manifestSha256: string;
  readonly slug: string;
  readonly unit: ConsentActUnit;
}

export interface SwitchOnInput extends ConsentActInput {
  /** Household units only. Validated against the active config.schema and written with the switch-on. */
  readonly config?: Record<string, unknown>;
}

export interface ConsentActResult {
  /** Null when the act would have changed nothing: no act, no event (ADR 0002). */
  readonly act: PluginConsentAct | null;
  readonly changed: boolean;
  /**
   * A review refuses a required permission, so the unit is switched off: by
   * this act, or already, when the unit was off and the denial stood before
   * the review arrived (`changed` is then false).
   */
  readonly switchedOff: boolean;
  readonly unit: HouseholdPlugin | UserPlugin;
}

type UnitEnablement = HouseholdPlugin | UserPlugin;

/** The manifest the act's sha names, as the request first read it. */
interface NamedManifest {
  /** The ACTIVE manifest, which a staged review's answers are judged against too. */
  readonly active: PluginManifestValidationResult;
  readonly source: ConsentManifestSource;
  readonly validated: PluginManifestValidationResult;
  readonly version: string;
}

/** The columns `claimPluginForAct` reads under the plugin row's share lock. */
interface ConsentActClaimRow {
  readonly installed_sha256: string;
  readonly pending_sha256: string | null;
  readonly pending_staging_id: string | null;
  readonly scope: PluginScope;
  readonly uninstalled_at: Date | null;
}

/** What a written act did to its unit enablement besides leaving it as `unit`. */
interface UnitEffects {
  readonly configWritten: boolean;
  readonly switchedOff: boolean;
}

type ActOutcome =
  | { readonly changed: false; readonly switchedOff: boolean; readonly unit: UnitEnablement }
  | (UnitEffects & {
      readonly act: PluginConsentAct;
      readonly changed: true;
      /** Only the decisions whose row changed: the ones an event announces. */
      readonly changedDecisions: readonly WrittenDecision[];
      readonly unit: UnitEnablement;
      readonly unitBefore: UnitEnablement | null;
    });

/**
 * The consent act writer (#1150): a household or user switches a plugin on,
 * toggles one optional requested permission, or reviews what an update left
 * outstanding, each as ONE recorded consent act. One transaction claims the
 * plugin row on the named manifest's sha, writes the act, the consent
 * decisions it carries and the unit enablement, and the events go out after
 * it commits.
 *
 * Its transaction takes, in this order: the household row, shared (#548); the
 * plugin row, shared, on the sha the act names; the consent decisions, in
 * permission order; the unit enablement. Two acts on one unit are not ordered
 * against each other (#1152). Each judges against the rows it reads and writes
 * by upsert, so the later write wins on each permission, the later switch-on
 * updates the unit enablement the earlier one created, and both acts stay on
 * record. The sha the claim compares is what keeps an act from landing on a
 * manifest that moved under it.
 *
 * Every writer that holds the plugin row shared takes the rows after it in
 * one order, so two acts wait on each other rather than deadlock. Should
 * Postgres still pick one as a deadlock victim, nothing here retries it: the
 * API answers 409 `TRANSACTION_DEADLOCK` with `fields.retryable: true`
 * (`TransactionDeadlockInterceptor`), and the client sends the act again.
 */
@Injectable()
export class PluginConsentActService {
  constructor(
    private readonly db: DatabaseService,
    private readonly classifier: PluginConsentCheckClassifier,
    private readonly authority: PluginGrantAuthorityService,
    private readonly configSchema: PluginConfigSchemaService,
    private readonly auditContext: AuditContextService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /** Switch the plugin on for the unit, granting at least every required permission at its scope. */
  switchOn(input: SwitchOnInput): Promise<ConsentActResult> {
    return this.commit('SwitchOn', input);
  }

  /** Grant or refuse one optional requested permission of a unit that is switched on. */
  toggle(input: ConsentActInput): Promise<ConsentActResult> {
    return this.commit('Toggle', input);
  }

  /**
   * Answer what the active manifest or a staged update leaves outstanding. A
   * refusal of a required permission switches the unit off in the same act.
   */
  review(input: ConsentActInput): Promise<ConsentActResult> {
    return this.commit('Review', input);
  }

  private async commit(kind: ConsentActKind, input: SwitchOnInput): Promise<ConsentActResult> {
    const initiatedAt = new Date();
    const { unit } = input;
    const household = unit.scopeType === 'Household';
    const scopeType = household ? PluginGrantScope.Household : PluginGrantScope.User;
    const scopeId = household ? unit.householdId : unit.userId;
    const config = household && kind === 'SwitchOn' ? input.config : undefined;

    // The plugin is read once per request, before the transaction (#361). The
    // claim inside it compares the sha this read named with the row it locks,
    // so a manifest that moved since, most often by an activation, is refused
    // stale rather than judged against (#1152).
    const plugin = await loadLivingPlugin(this.db, input.slug);
    const named = this.nameManifest(plugin, input.manifestSha256);

    await this.assertAuthority(unit, input.actorId);

    // A user's switch-on accepts the plugin's user-scope requests. A plugin
    // that makes none has nothing for it to accept, and the unit enablement
    // it would create confers nothing, so it is refused before any lock
    // (#381). Judged on the active manifest, the one a switch-on answers; the
    // claim below pins its sha, so it cannot move before the write.
    if (
      !household &&
      kind === 'SwitchOn' &&
      !named.active.permissionChecks.some((check) => unitOwnsConsentScope(check.consentScope, unit))
    ) {
      throw new PluginConsentActNoUserScopeError(plugin.slug);
    }

    const activeConfig = named.active.manifest.config;

    if (household && kind === 'SwitchOn') {
      assertHouseholdSurface(plugin.slug, plugin.scope);

      // A supplied document is judged against the ACTIVE schema before the
      // transaction, so an invalid one is refused before any lock is taken
      // (#323). Otherwise the schema is established usable and compiled
      // here: an unusable one is refused before any lock, and the config gate
      // inside the transaction, which asks the rule about the document the
      // unit would hold, compiles nothing while the locks are held (#1151).
      if (config !== undefined) {
        const issues = this.configSchema.validate({
          slug: plugin.slug,
          version: plugin.version,
          schema: activeConfig.schema,
          config,
        });

        if (issues.length > 0) {
          throw new PluginConfigValidationError(plugin.slug, issues);
        }
      } else {
        this.configSchema.assertUsable({ slug: plugin.slug, version: plugin.version, schema: activeConfig.schema });
      }
    }

    const correlationId = this.auditContext.getCorrelationId() ?? null;
    const locale = input.locale ?? this.options.defaultLocale;

    const outcome = await this.db.$transaction(async (tx): Promise<ActOutcome> => {
      // The household row first, shared (#548): the admin check above took
      // no lock, so a soft-delete can commit in between.
      if (household && !(await lockLiveHousehold(tx, unit.householdId))) {
        throw new PluginUnitHouseholdNotFoundError(unit.householdId);
      }

      // The plugin row next, shared. It must be held before the first grant
      // write: an INSERT into the grants table takes this row through its
      // foreign key only AFTER the grant tuple exists, so without the claim
      // this transaction would take the plugin row last and close a cycle
      // with activation (#398). The claim also compares the sha the consent
      // surface named, so nothing judged below can be judged against a
      // manifest that has since moved (#361, #1150), and returns the staging
      // a staged review answers, which the act records (#1152).
      const stagingId = await this.claimPluginForAct(tx, plugin.id, plugin.slug, {
        source: named.source,
        manifestSha256: input.manifestSha256,
        installedSha256: plugin.installedSha256,
        householdSurface: household && kind === 'SwitchOn',
      });

      // The catalog and the unit's decisions are read under the claim,
      // through this transaction, so the act judges against the manifest the
      // claim pinned (#361). No lock holds the decisions still: another act
      // on this unit can write between this read and this act's writes, and
      // the later write wins on each permission (#1152). Nothing locks
      // catalog rows: a risk edit landing before the commit leaves the
      // decision's risk below the catalog's, so it confers nothing
      // (`riskCovers`) and fails closed.
      const classification = await this.classifier.classify(plugin.id, unit, named.validated.permissionChecks, {
        source: named.source,
        client: tx,
      });

      // Throws every answer, required-set, ungrantable and risk refusal, so
      // nothing has been written when it does.
      const plan = planConsentAct({
        kind,
        pluginSlug: plugin.slug,
        unit,
        source: named.source,
        checks: named.validated.permissionChecks,
        activeChecks: named.active.permissionChecks,
        classification,
        answers: input.answers,
        locale,
        defaultLocale: this.options.defaultLocale,
      });

      // Read before anything is written, so an act that would change
      // nothing writes nothing: no act, no decision, no event.
      // A retried request then lands exactly where its first attempt left
      // the unit (ADR 0002, docs/adr/0002-retried-writes-use-client-request-ids.md).
      const unitBefore = await this.readUnitEnablement(tx, unit, plugin.id);

      // A household switch-on that supplies no document asks the dormancy
      // rule, with the active manifest, about the document it would leave
      // the unit holding: the retained one, or `{}` for a new unit
      // enablement. The gate refuses whatever the rule finds dormant. Asked
      // here, before the answer that changes nothing and before any write,
      // so a unit the read would call dormant is refused rather than
      // answered or half-recorded, whether or not it is already switched on
      // (#323, #1151). A supplied document was judged before the transaction.
      if (household && kind === 'SwitchOn' && config === undefined) {
        assertHeldConfigSatisfiesGate(this.configSchema, named.active, unitBefore as HouseholdPlugin | null);
      }

      const standingRows = await tx.pluginGrant.findMany({
        where: {
          pluginId: plugin.id,
          scopeType,
          scopeId,
          permissionSlug: { in: plan.decisions.map((decision) => decision.permissionSlug) },
        },
      });
      const standingBySlug = new Map(standingRows.map((row) => [row.permissionSlug, row]));
      const stand = decisionsStand(plan.decisions, standingBySlug);

      if (kind === 'SwitchOn') {
        if (stand && unitBefore !== null && unitBefore.enabled && config === undefined) {
          return { changed: false, unit: unitBefore, switchedOff: false };
        }
      } else {
        // A review that refuses a required permission asks for two things:
        // the denial recorded and the unit off. Both already hold, so it
        // changes nothing and answers as the review that left them so did,
        // `switchedOff` included: this is that review sent again, most
        // often. It is the one review a switched-off unit answers rather
        // than refuses, because the unit is where the request wants it (a
        // state change already at its target answers 2xx, ADR 0002)
        // whichever request put it there.
        if (plan.switchesOff && stand && unitBefore !== null && !unitBefore.enabled) {
          return { changed: false, unit: unitBefore, switchedOff: true };
        }

        // A toggle or review needs the unit switched on, as this read finds
        // it. A switch-off that commits after the read is not waited for:
        // the act's decisions stand on a unit that is off, as any decision
        // does when its unit is switched off later (#1152).
        if (unitBefore === null || !unitBefore.enabled) {
          throw new PluginConsentActUnitOffError(plugin.slug, unit.scopeType);
        }

        // A review that refuses a required permission changes the switch
        // even when its denial already stands (refused while optional, then
        // promoted by an update), so only an act that leaves the unit on can
        // change nothing (#1150).
        if (stand && !plan.switchesOff) {
          return { changed: false, unit: unitBefore, switchedOff: false };
        }
      }

      // A staged review (the claim returned a staging id) writes only the
      // decisions it changes. Activation keeps consent decisions (#1152), so
      // the staged manifest can request again a permission the unit decided
      // under an earlier one; rewritten here, that decision would name this
      // review's act, and rejecting the staging deletes every decision whose
      // act names it, a decision given before the staging existed included.
      // A kept decision the review changes becomes this staging's
      // pre-consent and goes with it, since nothing records the earlier
      // answer to put back. The presentation is unchanged, so the act still
      // records everything shown and answered. An act on the active manifest
      // writes every decision. The plan's decisions are already in permission
      // order, and the filter keeps it.
      const decisions =
        stagingId === null
          ? plan.decisions
          : plan.decisions.filter((decision) => !decisionStands(decision, standingBySlug.get(decision.permissionSlug)));
      const { act, changed: changedDecisions } = await writeConsentAct(tx, {
        pluginId: plugin.id,
        pluginSlug: plugin.slug,
        scopeType,
        scopeId,
        kind: PluginConsentActKind[kind],
        manifestVersion: named.version,
        manifestSha256: input.manifestSha256,
        stagingId,
        presentation: plan.presentation,
        decisions,
        standingBySlug,
        actorId: input.actorId,
        decidedAt: initiatedAt,
        correlationId,
      });

      // Every written outcome differs only in the unit it leaves and what
      // happened to it.
      const writtenOutcome = (unitAfter: UnitEnablement, effects: Partial<UnitEffects> = {}): ActOutcome => ({
        changed: true,
        act,
        changedDecisions,
        unitBefore,
        unit: unitAfter,
        switchedOff: effects.switchedOff ?? false,
        configWritten: effects.configWritten ?? false,
      });

      if (kind !== 'SwitchOn') {
        // Switched on: a toggle or review over any other unit was refused above.
        const switchedOn = unitBefore as UnitEnablement;

        if (!plan.switchesOff) {
          return writtenOutcome(switchedOn);
        }

        const switchedOff = household
          ? await tx.householdPlugin.update({ where: { id: switchedOn.id }, data: { enabled: false } })
          : await tx.userPlugin.update({ where: { id: switchedOn.id }, data: { enabled: false } });

        return writtenOutcome(switchedOff, { switchedOff: true });
      }

      if (household) {
        const existing = unitBefore as HouseholdPlugin | null;

        // A unit already switched on, with no document supplied, needs no
        // write: the gate above has judged the document it holds.
        if (existing !== null && existing.enabled && config === undefined) {
          return writtenOutcome(existing);
        }

        // By upsert, one statement, whether or not this act read a unit
        // enablement: a first switch-on racing this one can insert the row
        // after this act's read, and the later write then updates it rather
        // than colliding with it (#1152). A new unit enablement holds the
        // supplied document or `{}`; `config` undefined leaves a retained
        // document as it is, since Prisma writes no column whose value is
        // undefined.
        const written = await tx.householdPlugin.upsert({
          where: { householdId_pluginId: { householdId: unit.householdId, pluginId: plugin.id } },
          create: {
            householdId: unit.householdId,
            pluginId: plugin.id,
            enabled: true,
            config: (config ?? {}) as Prisma.InputJsonValue,
          },
          update: { enabled: true, config: config as Prisma.InputJsonValue | undefined },
        });

        return writtenOutcome(written, { configWritten: config !== undefined });
      }

      const written = await tx.userPlugin.upsert({
        where: { userId_pluginId: { userId: unit.userId, pluginId: plugin.id } },
        create: { userId: unit.userId, pluginId: plugin.id, enabled: true },
        update: { enabled: true },
      });

      return writtenOutcome(written);
    });

    if (!outcome.changed) {
      return { act: null, changed: false, unit: outcome.unit, switchedOff: outcome.switchedOff };
    }

    this.emitEvents(outcome, named.version, initiatedAt);

    return { act: outcome.act, changed: true, unit: outcome.unit, switchedOff: outcome.switchedOff };
  }

  /**
   * The plugin-row claim of a consent act: the row `FOR SHARE`, as every
   * per-unit writer takes it (#398), and the check that the manifest the act
   * names is still the one the row holds (#1150). The sha pins the exact
   * bytes, so no comparison of the manifest's content is needed.
   *
   * A staged review pins BOTH shas: the staged one it names, and the active
   * one the request read, because the planner judged which staged
   * permissions are new against that active manifest.
   *
   * Returns the staging the act answers: the row's `pending_staging_id`, read
   * under the same lock as the staged sha, for a staged review, and null for
   * an act on the active manifest. A rejection deletes the consent decisions
   * whose act names its staging, so a staged review that named none could
   * never be cleared away (#1152).
   */
  private async claimPluginForAct(
    tx: Prisma.TransactionClient,
    pluginId: string,
    pluginSlug: string,
    expected: {
      /** A household switch-on writes a household surface, which the plugin's scope must still admit. */
      readonly householdSurface: boolean;
      /** `installedSha256` of the plugin row read before the transaction. */
      readonly installedSha256: string;
      readonly manifestSha256: string;
      readonly source: ConsentManifestSource;
    },
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<ConsentActClaimRow[]>`SELECT uninstalled_at, scope, installed_sha256,
        pending_sha256, pending_staging_id
        FROM plugins WHERE id = ${pluginId} FOR SHARE`;
    const row = rows[0];

    if (row === undefined) {
      throw new PluginUnitPluginNotFoundError(pluginSlug);
    }

    if (row.uninstalled_at !== null) {
      throw new PluginUnitPluginTombstonedError(pluginSlug, row.uninstalled_at);
    }

    const current =
      expected.source === 'active'
        ? row.installed_sha256 === expected.manifestSha256
        : row.pending_sha256 === expected.manifestSha256 && row.installed_sha256 === expected.installedSha256;

    if (!current) {
      throw new PluginConsentActStaleError(pluginSlug, 'manifest');
    }

    if (expected.householdSurface) {
      assertHouseholdSurface(pluginSlug, row.scope);
    }

    if (expected.source === 'active') {
      return null;
    }

    // The database keeps the staged columns all set or all null
    // (`plugins_staged_update_all_or_nothing`), so a staged sha with no
    // staging id is unreachable. Should one be read, the review is refused
    // rather than recorded naming no staging.
    if (row.pending_staging_id === null) {
      throw new PluginConsentActStaleError(pluginSlug, 'manifest');
    }

    return row.pending_staging_id;
  }

  /**
   * The manifest the consent surface named by its sha: the active one, or a
   * staged update's. Any other sha is a consent surface that is out of date.
   * The planner refuses a staged sha for anything but a review.
   */
  private nameManifest(plugin: Plugin, manifestSha256: string): NamedManifest {
    const active = this.revalidate(plugin.slug, plugin.version, plugin.manifestJson);

    if (manifestSha256 === plugin.installedSha256) {
      return { source: 'active', version: plugin.version, validated: active, active };
    }

    if (plugin.pendingSha256 !== null && manifestSha256 === plugin.pendingSha256 && plugin.pendingVersion !== null) {
      const staged = this.revalidate(plugin.slug, plugin.pendingVersion, plugin.pendingManifestJson);

      return { source: 'staged', version: plugin.pendingVersion, validated: staged, active };
    }

    throw new PluginConsentActStaleError(plugin.slug, 'manifest');
  }

  private revalidate(slug: string, version: string, manifestJson: unknown): PluginManifestValidationResult {
    return revalidateStoredManifest(
      { slug, version, manifestJson },
      this.options,
      (pluginSlug, detail, issues) => new PluginUnitManifestError(pluginSlug, detail, issues),
    );
  }

  /**
   * A household act needs a household admin; once the household is deleted,
   * its own admin gets the 404 and anyone else keeps the 403 (#548). A user
   * act is decided by the user themself (#225).
   */
  private async assertAuthority(unit: ConsentActUnit, actorId: string): Promise<void> {
    if (unit.scopeType === 'User') {
      if (actorId !== unit.userId) {
        throw new PluginUnitAuthorityError(actorId);
      }

      return;
    }

    await assertHouseholdAdmin(this.authority, actorId, unit.householdId);
  }

  private readUnitEnablement(
    tx: Prisma.TransactionClient,
    unit: ConsentActUnit,
    pluginId: string,
  ): Promise<UnitEnablement | null> {
    return unit.scopeType === 'Household'
      ? tx.householdPlugin.findUnique({
          where: { householdId_pluginId: { householdId: unit.householdId, pluginId } },
        })
      : tx.userPlugin.findUnique({ where: { userId_pluginId: { userId: unit.userId, pluginId } } });
  }

  /**
   * Every event an act causes carries the act, so each lifecycle row it leaves
   * names it, and every recorded act leaves at least one: a changed decision,
   * a switch or a config write (#1150). An act is recorded only when one of
   * those changes: a switch-on whose decisions stand over a unit already on,
   * with no document supplied, answers `changed: false` and writes nothing.
   */
  private emitEvents(
    outcome: Extract<ActOutcome, { changed: true }>,
    manifestVersion: string,
    initiatedAt: Date,
  ): void {
    const context = { manifestVersion, actId: outcome.act.id };

    emitDecisionEvents(this.emitter, outcome.changedDecisions, context, initiatedAt);

    const { unitBefore, unit } = outcome;
    const switchedOn = unit.enabled && (unitBefore === null || !unitBefore.enabled);

    if (isHouseholdEnablement(unit)) {
      const before = unitBefore as HouseholdPlugin | null;

      if (switchedOn) {
        this.emitter.emit(
          HouseholdPluginEnabledEvent.eventName,
          new HouseholdPluginEnabledEvent(
            before === null ? null : householdSwitchSnapshot(before),
            householdSwitchSnapshot(unit),
            initiatedAt,
            context,
          ),
        );
      }

      if (outcome.switchedOff && before !== null) {
        this.emitter.emit(
          HouseholdPluginDisabledEvent.eventName,
          new HouseholdPluginDisabledEvent(
            householdSwitchSnapshot(before),
            householdSwitchSnapshot(unit),
            initiatedAt,
            context,
          ),
        );
      }

      if (outcome.configWritten) {
        // On creation the before is the `{}` column default the unit
        // enablement was born from, so a listener sees the whole document
        // arrive (#323).
        const configBefore = before ?? {
          id: unit.id,
          householdId: unit.householdId,
          pluginId: unit.pluginId,
          config: {},
        };

        this.emitter.emit(
          HouseholdPluginConfigUpdatedEvent.eventName,
          new HouseholdPluginConfigUpdatedEvent(configBefore, unit, initiatedAt, context),
        );
      }

      return;
    }

    const before = unitBefore as UserPlugin | null;

    if (switchedOn) {
      this.emitter.emit(
        UserPluginEnabledEvent.eventName,
        new UserPluginEnabledEvent(
          before === null ? null : userSwitchSnapshot(before),
          userSwitchSnapshot(unit),
          initiatedAt,
          context,
        ),
      );
    }

    if (outcome.switchedOff && before !== null) {
      this.emitter.emit(
        UserPluginDisabledEvent.eventName,
        new UserPluginDisabledEvent(userSwitchSnapshot(before), userSwitchSnapshot(unit), initiatedAt, context),
      );
    }
  }
}

function isHouseholdEnablement(row: UnitEnablement): row is HouseholdPlugin {
  return 'householdId' in row;
}
