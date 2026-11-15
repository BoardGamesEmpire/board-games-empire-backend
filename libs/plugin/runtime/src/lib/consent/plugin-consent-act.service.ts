import { AuditContextService } from '@bge/actor-context';
import type { HouseholdPlugin, Plugin, PluginConsentAct, PluginGrant, PluginScope, UserPlugin } from '@bge/database';
import {
  DatabaseService,
  lockLiveHousehold,
  PluginConsentActKind,
  PluginGrantScope,
  PluginGrantStatus,
  PluginUnitDormantReason,
  Prisma,
  retryOnDeadlock,
} from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigValidationError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import {
  grantSnapshot,
  householdDormancySnapshot,
  householdSwitchSnapshot,
  userSwitchSnapshot,
} from '../events/plugin-event-snapshots';
import {
  HouseholdPluginConfigUpdatedEvent,
  HouseholdPluginDisabledEvent,
  HouseholdPluginEnabledEvent,
  HouseholdPluginUnitRevivedEvent,
  PluginGrantCreatedEvent,
  PluginGrantRejectedEvent,
  UserPluginDisabledEvent,
  UserPluginEnabledEvent,
} from '../events/plugin.events';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { lockHouseholdUnitScope, lockUserUnitScope } from '../grants/unit-scope-lock';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import { MODULE_OPTIONS_TOKEN, type PluginModuleOptions } from '../plugin-module.options';
import { assertHouseholdAdmin } from '../units/household-admin-assertion';
import { assertRetainedConfigSatisfiesGate, configDormancyCleared } from '../units/household-config-gate';
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
import {
  PluginConsentActNoUserScopeError,
  PluginConsentActStaleError,
  PluginConsentActUnitOffError,
} from './plugin-consent-act.errors';
import type { ConsentActAnswer, ConsentActDecision, ConsentActKind, ConsentActUnit } from './plugin-consent-act.types';
import { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';

export interface ConsentActInput {
  readonly slug: string;
  readonly unit: ConsentActUnit;
  /** The acting user: a household admin for a household unit, the user themself for a user unit. Verified here. */
  readonly actorId: string;
  readonly manifestSha256: string;
  readonly answers: readonly ConsentActAnswer[];
  readonly locale?: string;
}

export interface SwitchOnInput extends ConsentActInput {
  /** Household units only. Validated against the active config.schema and written with the switch-on. */
  readonly config?: Record<string, unknown>;
}

export interface ConsentActResult {
  /** Null when the act would have changed nothing: no act, no event (ADR 0002). */
  readonly act: PluginConsentAct | null;
  readonly changed: boolean;
  readonly unit: HouseholdPlugin | UserPlugin;
  /**
   * A review refuses a required permission, so the unit is switched off: by
   * this act, or already, when the unit was off and the denial stood before
   * the review arrived (`changed` is then false).
   */
  readonly switchedOff: boolean;
}

type UnitEnablement = HouseholdPlugin | UserPlugin;

/** The manifest the act's sha names, as the request first read it. */
interface NamedManifest {
  readonly source: ConsentManifestSource;
  readonly version: string;
  readonly validated: PluginManifestValidationResult;
  /** The ACTIVE manifest, which a staged review's answers are judged against too. */
  readonly active: PluginManifestValidationResult;
}

/** The columns `claimPluginForAct` reads under the plugin row's share lock. */
interface ConsentActClaimRow {
  readonly uninstalled_at: Date | null;
  readonly scope: PluginScope;
  readonly installed_sha256: string;
  readonly pending_sha256: string | null;
}

interface WrittenDecision {
  readonly before: PluginGrant | null;
  readonly after: PluginGrant;
}

/** What a written act did to its unit enablement besides leaving it as `unit`. */
interface UnitEffects {
  readonly switchedOff: boolean;
  readonly configWritten: boolean;
  /** The dormancy the act lifted from a household unit, if any. */
  readonly clearedDormancy: PluginUnitDormantReason | null;
}

type ActOutcome =
  | { readonly changed: false; readonly unit: UnitEnablement; readonly switchedOff: boolean }
  | (UnitEffects & {
      readonly changed: true;
      readonly act: PluginConsentAct;
      /** Only the decisions whose row changed: the ones an event announces. */
      readonly changedDecisions: readonly WrittenDecision[];
      readonly unitBefore: UnitEnablement | null;
      readonly unit: UnitEnablement;
    });

/**
 * The consent act writer (#1150): a household or user switches a plugin on,
 * toggles one optional requested permission, or reviews what an update left
 * outstanding, each as ONE recorded consent act. One transaction claims the
 * plugin row on the named manifest's sha, writes the act, the consent
 * decisions it carries and the unit enablement, and the events go out after
 * it commits.
 *
 * It takes the total lock order every per-unit writer of the plugin runtime
 * takes (`apps/api-e2e/src/plugin/lock-order.ts`): household row, plugin row,
 * the unit's advisory key, grant rows, the unit enablement. `decide()` and
 * `PluginUnitLifecycleService` explain each stage; the comments in `commit`
 * say only what is particular to an act.
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

    // The plugin is read once per request, before the transaction, and a
    // deadlock replay judges against this same read (#361, as `decide()`
    // does). A deadlock means a writer of this plugin row was live, most
    // often an activation (#398); a replay that read again would record
    // consent against a manifest that moved mid-request with nothing telling
    // the client. Judged against the first read, the replay's claim sees the
    // move and refuses it with the same stale refusal.
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
      // (#323); otherwise the schema is warmed, so the
      // retained-config gate under the advisory key does not compile it
      // inside the lock window.
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
        this.configSchema.warm({ slug: plugin.slug, version: plugin.version, schema: activeConfig.schema });
      }
    }

    const correlationId = this.auditContext.getCorrelationId() ?? null;
    const locale = input.locale ?? this.options.defaultLocale;

    // Retried once if Postgres picks this attempt as the deadlock victim, as
    // `decide()` is (#398): the abort took the transaction whole and the
    // events emit below, after the commit, so a replay writes nothing twice.
    const outcome = await retryOnDeadlock(() =>
      this.db.$transaction(async (tx): Promise<ActOutcome> => {
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
        // manifest that has since moved (#361, #1150).
        await this.claimPluginForAct(tx, plugin.id, plugin.slug, {
          source: named.source,
          manifestSha256: input.manifestSha256,
          installedSha256: plugin.installedSha256,
          householdSurface: household && kind === 'SwitchOn',
        });

        // The catalog and the unit's decisions are read under the claim, through
        // this transaction, for the reason `decide()` reads the risk there (#361).
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

        // The unit's advisory key, before anything that judges or writes this
        // unit. Every other writer of the unit takes it before the unit
        // enablement (see unit-scope-lock.ts); an act takes it before its
        // decisions as well, so two acts on one unit run one after the other.
        // The later one reads the decisions and the switch the earlier one
        // left: it records nothing when they already say what it asks, and it
        // announces its own changes against those rows, never against rows
        // the earlier act has since replaced (#1150).
        if (household) {
          await lockHouseholdUnitScope(tx, unit.householdId, plugin.id);
        } else {
          await lockUserUnitScope(tx, unit.userId, plugin.id);
        }

        // Read under the key, before anything is written, so an act that
        // would change nothing writes nothing: no act, no decision, no event.
        // A retried request then lands exactly where its first attempt left
        // the unit (ADR 0002, docs/adr/0002-retried-writes-use-client-request-ids.md).
        const unitBefore = await this.readUnitEnablement(tx, unit, plugin.id);
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
          if (stand && unitBefore !== null && unitBefore.enabled && !isDormant(unitBefore) && config === undefined) {
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

          // A toggle or review needs the unit switched on. Judged under the
          // key, so no switch-off can commit between this read and the act.
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

        const act = await tx.pluginConsentAct.create({
          data: {
            pluginId: plugin.id,
            pluginSlug: plugin.slug,
            scopeType,
            scopeId,
            kind: PluginConsentActKind[kind],
            manifestVersion: named.version,
            manifestSha256: input.manifestSha256,
            presentation: plan.presentation as unknown as Prisma.InputJsonValue,
            decidedById: input.actorId,
            decidedAt: initiatedAt,
            correlationId,
          },
        });

        // Every planned decision is written, the ones that already stand
        // included, so a row's actId always names the act that last set it.
        // In permission order, which the plan sorts by code unit: two acts on
        // one unit then take their grant rows in the same order, where any
        // other order lets each hold a row the other waits on.
        const changedDecisions: WrittenDecision[] = [];

        for (const decision of plan.decisions) {
          const fields = {
            status: decision.status,
            decidedRiskLevel: decision.decidedRiskLevel,
            decidedById: input.actorId,
            decidedAt: initiatedAt,
            actId: act.id,
          };
          const after = await tx.pluginGrant.upsert({
            where: {
              pluginId_scopeType_scopeId_permissionSlug: {
                pluginId: plugin.id,
                scopeType,
                scopeId,
                permissionSlug: decision.permissionSlug,
              },
            },
            create: { pluginId: plugin.id, scopeType, scopeId, permissionSlug: decision.permissionSlug, ...fields },
            update: fields,
          });
          const before = standingBySlug.get(decision.permissionSlug) ?? null;

          if (!decisionStands(decision, before)) {
            changedDecisions.push({ before, after });
          }
        }

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
          clearedDormancy: effects.clearedDormancy ?? null,
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

          // A unit already in service needs no write, and the config gate
          // guards only the transition into service (#323).
          if (existing !== null && existing.enabled && existing.dormantReason === null && config === undefined) {
            return writtenOutcome(existing);
          }

          if (
            config === undefined &&
            (activeConfig.requiresHouseholdConfig ||
              existing?.dormantReason === PluginUnitDormantReason.NeedsConfiguration)
          ) {
            assertRetainedConfigSatisfiesGate(this.configSchema, plugin, activeConfig.schema, existing);
          }

          const written =
            existing === null
              ? await tx.householdPlugin.create({
                  data: {
                    householdId: unit.householdId,
                    pluginId: plugin.id,
                    enabled: true,
                    config: (config ?? {}) as Prisma.InputJsonValue,
                  },
                })
              : await tx.householdPlugin.update({
                  where: { id: existing.id },
                  data: {
                    ...(existing.enabled ? {} : { enabled: true }),
                    ...(config !== undefined ? { config: config as Prisma.InputJsonValue } : {}),
                    ...configDormancyCleared(existing),
                  },
                });

          // The switch-on lifted a configuration dormancy, which no switch or
          // config event would otherwise announce (#1150).
          const clearedDormancy =
            existing !== null && existing.dormantReason !== null && written.dormantReason === null
              ? existing.dormantReason
              : null;

          return writtenOutcome(written, { configWritten: config !== undefined, clearedDormancy });
        }

        const written = await tx.userPlugin.upsert({
          where: { userId_pluginId: { userId: unit.userId, pluginId: plugin.id } },
          create: { userId: unit.userId, pluginId: plugin.id, enabled: true },
          update: { enabled: true },
        });

        return writtenOutcome(written);
      }),
    );

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
   * bytes, so it replaces `decide()`'s content comparison.
   *
   * A staged review pins BOTH shas: the staged one it names, and the active
   * one the request read, because the planner judged which staged
   * permissions are new against that active manifest.
   */
  private async claimPluginForAct(
    tx: Prisma.TransactionClient,
    pluginId: string,
    pluginSlug: string,
    expected: {
      readonly source: ConsentManifestSource;
      readonly manifestSha256: string;
      /** `installedSha256` of the plugin row read before the transaction. */
      readonly installedSha256: string;
      /** A household switch-on writes a household surface, which the plugin's scope must still admit. */
      readonly householdSurface: boolean;
    },
  ): Promise<void> {
    const rows = await tx.$queryRaw<ConsentActClaimRow[]>`SELECT uninstalled_at, scope, installed_sha256, pending_sha256
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
   * a switch, a config write or a lifted dormancy (#1150).
   */
  private emitEvents(
    outcome: Extract<ActOutcome, { changed: true }>,
    manifestVersion: string,
    initiatedAt: Date,
  ): void {
    const context = { manifestVersion, actId: outcome.act.id };

    for (const { before, after } of outcome.changedDecisions) {
      const EventClass =
        after.status === PluginGrantStatus.Granted ? PluginGrantCreatedEvent : PluginGrantRejectedEvent;

      this.emitter.emit(
        EventClass.eventName,
        new EventClass(before === null ? null : grantSnapshot(before), grantSnapshot(after), context, initiatedAt),
      );
    }

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

      if (outcome.clearedDormancy !== null && before !== null) {
        this.emitter.emit(
          HouseholdPluginUnitRevivedEvent.eventName,
          new HouseholdPluginUnitRevivedEvent(
            householdDormancySnapshot(before),
            householdDormancySnapshot(unit),
            outcome.clearedDormancy,
            manifestVersion,
            initiatedAt,
            outcome.act.id,
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

/** The row already holds this decision: same status, same risk. */
function decisionStands(decision: ConsentActDecision, row: PluginGrant | null | undefined): boolean {
  return row != null && row.status === decision.status && row.decidedRiskLevel === decision.decidedRiskLevel;
}

/** Every planned decision already stands at the unit's coordinates. */
function decisionsStand(
  decisions: readonly ConsentActDecision[],
  standingBySlug: ReadonlyMap<string, PluginGrant>,
): boolean {
  return decisions.every((decision) => decisionStands(decision, standingBySlug.get(decision.permissionSlug)));
}

function isDormant(row: UnitEnablement): boolean {
  return 'dormantReason' in row && row.dormantReason !== null;
}

function isHouseholdEnablement(row: UnitEnablement): row is HouseholdPlugin {
  return 'householdId' in row;
}
