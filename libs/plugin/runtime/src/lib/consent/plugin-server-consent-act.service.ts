import { AuditContextService, SERVER_PLUGIN_UNIT } from '@bge/actor-context';
import type { Plugin, PluginConsentAct } from '@bge/database';
import { DatabaseService, PluginConsentActKind, PluginGrantScope, Prisma, SERVER_SCOPE_SENTINEL } from '@bge/database';
import type { PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginGrantAuthorityService } from '../grants/plugin-grant-authority.service';
import { PluginLifecycleAuthorityError } from '../lifecycle/lifecycle.errors';
import { revalidateStoredManifest } from '../manifest/stored-manifest';
import type { PluginModuleOptions } from '../plugin-module.options';
import { MODULE_OPTIONS_TOKEN } from '../plugin-module.options';
import { loadLivingPlugin } from '../units/living-plugin';
import {
  PluginUnitManifestError,
  PluginUnitPluginNotFoundError,
  PluginUnitPluginTombstonedError,
} from '../units/unit.errors';
import { planConsentAct } from './consent-act-plan';
import type { WrittenDecision } from './consent-decision-events';
import { emitDecisionEvents } from './consent-decision-events';
import { decisionsStand } from './consent-decision-stands';
import { PluginConsentActStaleError } from './plugin-consent-act.errors';
import type { ConsentActAnswer } from './plugin-consent-act.types';
import { PluginConsentCheckClassifier } from './plugin-consent-check-classifier.service';
import { writeConsentAct } from './write-consent-act';

export interface ServerConsentActInput {
  /** The acting server admin. Verified here. */
  readonly actorId: string;

  readonly answers: readonly ConsentActAnswer[];
  readonly locale?: string;
  readonly manifestSha256: string;
  readonly slug: string;
}

export interface ServerConsentActResult {
  /** Null when the act would have changed nothing: no act, no event (ADR 0002). */
  readonly act: PluginConsentAct | null;

  readonly changed: boolean;
}

/** The kinds of act a server admin records for the Server unit outside install and approval. */
type ServerConsentActKind = 'Toggle' | 'Review';

/** The columns `claimPluginForAct` reads under the plugin row's share lock. */
interface ServerConsentActClaimRow {
  readonly installed_sha256: string;
  readonly uninstalled_at: Date | null;
}

type ServerActOutcome =
  | { readonly changed: false }
  | {
      readonly act: PluginConsentAct;
      readonly changed: true;

      /** Only the decisions whose row changed: the ones an event announces. */
      readonly changedDecisions: readonly WrittenDecision[];
    };

/**
 * The Server unit's consent act writer (#1336): a server admin grants or
 * refuses one optional server-scope requested permission, or accepts what a
 * catalog risk rise left outstanding, each as ONE recorded consent act. One
 * transaction claims the plugin row on the active manifest's sha, writes the
 * act and the consent decisions it carries, and the events go out after it
 * commits.
 *
 * The Server unit has no household row and no unit enablement, so its
 * transaction takes the plugin row, shared, on the sha the act names, and then
 * the consent decisions, in permission order. Two acts on the Server unit are
 * not ordered against each other: the later write wins on each permission and
 * both acts stay on record (#1152).
 *
 * It answers only the active manifest: the server admin consents to a staged
 * update by approving it. It never reads the Server switch: consenting before
 * the plugin is switched on is a legitimate order.
 */
@Injectable()
export class PluginServerConsentActService {
  constructor(
    private readonly db: DatabaseService,
    private readonly classifier: PluginConsentCheckClassifier,
    private readonly authority: PluginGrantAuthorityService,
    private readonly auditContext: AuditContextService,
    private readonly emitter: EventEmitter2,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PluginModuleOptions,
  ) {}

  /** Grant or refuse one optional server-scope requested permission. */
  toggle(input: ServerConsentActInput): Promise<ServerConsentActResult> {
    return this.commit('Toggle', input);
  }

  /**
   * Accept what the active manifest leaves outstanding at server scope, most
   * often a permission whose catalog risk rose. A review only grants: the
   * server admin refuses an optional permission by toggling it.
   */
  review(input: ServerConsentActInput): Promise<ServerConsentActResult> {
    return this.commit('Review', input);
  }

  private async commit(kind: ServerConsentActKind, input: ServerConsentActInput): Promise<ServerConsentActResult> {
    const initiatedAt = new Date();
    const plugin = await loadLivingPlugin(this.db, input.slug);

    if (!(await this.authority.isServerAdmin(input.actorId))) {
      throw new PluginLifecycleAuthorityError(input.actorId);
    }

    // The staged sha is stale here too: the Server unit consents to a staged
    // update by approving it, not through an act.
    if (input.manifestSha256 !== plugin.installedSha256) {
      throw new PluginConsentActStaleError(plugin.slug, 'manifest');
    }

    const validated = this.revalidate(plugin);
    const correlationId = this.auditContext.getCorrelationId() ?? null;
    const locale = input.locale ?? this.options.defaultLocale;

    const outcome = await this.db.$transaction(async (tx): Promise<ServerActOutcome> => {
      // The plugin row first, shared. It must be held before the first grant
      // write: an INSERT into the grants table takes this row through its
      // foreign key only AFTER the grant tuple exists, so without the claim
      // this transaction would take the plugin row last and close a cycle
      // with activation (#398). The claim also compares the sha the consent
      // surface named, so nothing judged below is judged against a manifest
      // that has since moved (#1336).
      await this.claimPluginForAct(tx, plugin.id, plugin.slug, plugin.installedSha256);

      // The catalog and the Server unit's decisions are read under the claim,
      // through this transaction. Nothing locks catalog rows, so an Owner's
      // risk edit can still land before the commit; the decision then holds
      // a risk below the catalog's, confers nothing (`riskCovers`) and leaves
      // the unit owing a review, so a late edit fails closed (#1336).
      const classification = await this.classifier.classify(plugin.id, SERVER_PLUGIN_UNIT, validated.permissionChecks, {
        source: 'active',
        client: tx,
      });

      // Throws every answer, ungrantable and risk refusal, so nothing has been
      // written when it does.
      const plan = planConsentAct({
        kind,
        pluginSlug: plugin.slug,
        unit: SERVER_PLUGIN_UNIT,
        source: 'active',
        checks: validated.permissionChecks,
        activeChecks: validated.permissionChecks,
        classification,
        answers: input.answers,
        locale,
        defaultLocale: this.options.defaultLocale,
      });

      // Read before anything is written, so an act that would change nothing
      // writes nothing: no act, no decision, no event. A retried request then
      // lands exactly where its first attempt left the Server unit (ADR 0002,
      // docs/adr/0002-retried-writes-use-client-request-ids.md).
      const standingRows = await tx.pluginGrant.findMany({
        where: {
          pluginId: plugin.id,
          scopeType: PluginGrantScope.Server,
          scopeId: SERVER_SCOPE_SENTINEL,
          permissionSlug: { in: plan.decisions.map((decision) => decision.permissionSlug) },
        },
      });
      const standingBySlug = new Map(standingRows.map((row) => [row.permissionSlug, row]));

      if (decisionsStand(plan.decisions, standingBySlug)) {
        return { changed: false };
      }

      // The plan's decisions are already in permission order.
      const written = await writeConsentAct(tx, {
        pluginId: plugin.id,
        pluginSlug: plugin.slug,
        scopeType: PluginGrantScope.Server,
        scopeId: SERVER_SCOPE_SENTINEL,
        kind: PluginConsentActKind[kind],
        manifestVersion: plugin.version,
        manifestSha256: input.manifestSha256,
        // The claim admits only the active sha: the Server unit answers a
        // staged update through approval, never through this act.
        stagingId: null,
        presentation: plan.presentation,
        decisions: plan.decisions,
        standingBySlug,
        actorId: input.actorId,
        decidedAt: initiatedAt,
        correlationId,
      });

      return { changed: true, act: written.act, changedDecisions: written.changed };
    });

    if (!outcome.changed) {
      return { act: null, changed: false };
    }

    // One event per decision whose row changed, each carrying the act, so
    // every lifecycle row a server act leaves names it (#1336).
    emitDecisionEvents(
      this.emitter,
      outcome.changedDecisions,
      { manifestVersion: plugin.version, actId: outcome.act.id },
      initiatedAt,
    );

    return { act: outcome.act, changed: true };
  }

  /**
   * The plugin-row claim of a server consent act: the row `FOR SHARE`, as
   * every consent act takes it (#398), and the check that the active manifest
   * the act names is still the one the row holds (#1336). The sha pins the
   * exact bytes.
   */
  private async claimPluginForAct(
    tx: Prisma.TransactionClient,
    pluginId: string,
    pluginSlug: string,
    installedSha256: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<ServerConsentActClaimRow[]>`SELECT uninstalled_at, installed_sha256
        FROM plugins WHERE id = ${pluginId} FOR SHARE`;
    const row = rows[0];

    if (row === undefined) {
      throw new PluginUnitPluginNotFoundError(pluginSlug);
    }

    if (row.uninstalled_at !== null) {
      throw new PluginUnitPluginTombstonedError(pluginSlug, row.uninstalled_at);
    }

    if (row.installed_sha256 !== installedSha256) {
      throw new PluginConsentActStaleError(pluginSlug, 'manifest');
    }
  }

  private revalidate(plugin: Plugin): PluginManifestValidationResult {
    return revalidateStoredManifest(
      { slug: plugin.slug, version: plugin.version, manifestJson: plugin.manifestJson },
      this.options,
      (pluginSlug, detail, issues) => new PluginUnitManifestError(pluginSlug, detail, issues),
    );
  }
}
