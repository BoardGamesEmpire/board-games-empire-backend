import { AuditContextService, SERVER_PLUGIN_UNIT } from '@bge/actor-context';
import { Action, PluginGrantScope, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import {
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginGrantService,
  PluginLifecycleService,
  PluginUpdateNoPendingError,
  PluginUpdateService,
} from '@bge/plugin';
import { NoCache } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApprovePluginUpdateDto, DecidePluginGrantDto, UninstallPluginDto, UpdatePluginConfigDto } from './dto';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';

/**
 * Server-level plugin lifecycle (#59 Phase C4, #320): the admin's
 * enable/disable switch, the server config write, and uninstall. Plugins
 * are addressed by slug at the HTTP edge; toggles are POST verb sub-paths
 * per house style, and uninstall is a POST rather than a DELETE because the
 * resource tombstones (410 afterward) instead of disappearing — and
 * `purgeData` belongs in a body, which DELETE should not carry.
 *
 * The coarse `manage:plugin` CASL gate lives here; the service seam
 * re-verifies server-admin authority and owns every domain rule. Actor
 * identity is resolved from CLS at this edge and passed into the runtime
 * input — never read from a request body.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@UseFilters(PluginExceptionFilter)
@ApiTags('plugins')
@Controller('plugins')
export class PluginsController {
  constructor(
    private readonly lifecycle: PluginLifecycleService,
    private readonly abilityService: AbilityService,
    private readonly updates: PluginUpdateService,
    private readonly grants: PluginGrantService,
    private readonly presentation: PluginConsentPresentationService,
    private readonly featureState: PluginFeatureStateService,
    private readonly auditContext: AuditContextService,
  ) {}

  // ─── Grant decisions + consent presentation (#322): Server scope ──────────

  @ApiOperation({
    summary: 'Record a server-scope consent decision for one requested permission',
    description:
      'Grant or durably deny a permission the active manifest requests at server consent scope. Idempotent on ' +
      'exact re-statement (changed: false). Denying a permission the active manifest REQUIRES is refused with a ' +
      '409 naming the honest levers — disable or uninstall (D-AV); a permission only a staged update requires ' +
      'stays deniable, and blocks at approve instead.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Insufficient permissions, or a categorically ungrantable permission',
  })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({
    status: Http.Conflict,
    description: 'Denial refused: the active manifest requires this permission (disable or uninstall instead)',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'Not requested by the manifest, or decided at the wrong consent scope',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/grants')
  decideGrant(@Param('slug') slug: string, @Body() dto: DecidePluginGrantDto) {
    return from(
      this.grants.decide({
        slug,
        scopeType: PluginGrantScope.Server,
        permissionSlug: dto.permissionSlug,
        status: dto.status,
        deciderId: this.abilityService.getActingUserId(),
      }),
    ).pipe(
      map(({ grant, changed }) => ({
        message: t('success.plugin.grant_decided', { slug, permissionSlug: dto.permissionSlug }),
        grant,
        changed,
      })),
    );
  }

  @ApiOperation({
    summary: "Present the active manifest's consent surface for the Server unit",
    description:
      "The server admin's consent screen: every check the active manifest requests — riskLevel, required, " +
      'consentScope, localized reason, feature binding, and its decision state from this viewpoint (unit-scope ' +
      "checks read 'per-unit') — plus the localized features[] the checks group under.",
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Plugin))
  // Mutation-adjacent by definition: it exists to be read right before a
  // decide POST, and the decide's write must be visible on the re-read. The
  // response cache also keys without the resolved locale (#358), which
  // would cross-serve this fully localized body between locales.
  @NoCache()
  @Get(':slug/consent')
  consentPresentation(@Param('slug') slug: string) {
    return from(
      this.presentation.presentForUnitBySlug(slug, SERVER_PLUGIN_UNIT, this.auditContext.getLocale() ?? undefined),
    ).pipe(map((presentation) => ({ presentation })));
  }

  @ApiOperation({ summary: 'Enable a plugin (server-level switch)' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/enable')
  enable(@Param('slug') slug: string) {
    return from(this.lifecycle.enable({ slug, actorId: this.abilityService.getActingUserId() })).pipe(
      map((plugin) => ({ message: t('success.plugin.enabled', { slug }), plugin })),
    );
  }

  @ApiOperation({ summary: 'Disable a plugin (server-level switch)' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/disable')
  disable(@Param('slug') slug: string) {
    return from(this.lifecycle.disable({ slug, actorId: this.abilityService.getActingUserId() })).pipe(
      map((plugin) => ({ message: t('success.plugin.disabled', { slug }), plugin })),
    );
  }

  @ApiOperation({
    summary: 'Replace the server-scope plugin configuration',
    description:
      "Validates the payload against the manifest's config.schema (422 with issues[] on violation), persists it, " +
      'and triggers the config hot-reload. Last-writer-wins; there is no optimistic locking.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({ status: Http.UnprocessableEntity, description: 'Configuration violates the declared schema' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @Patch(':slug/config')
  updateConfig(@Param('slug') slug: string, @Body() dto: UpdatePluginConfigDto) {
    return from(
      this.lifecycle.updateConfig({ slug, actorId: this.abilityService.getActingUserId(), config: dto.config }),
    ).pipe(map((plugin) => ({ message: t('success.plugin.config_updated', { slug }), plugin })));
  }

  @ApiOperation({
    summary: 'Uninstall a plugin (tombstone)',
    description:
      'Purges all consent (grants and the declared-permission catalog — reinstall is fresh consent), retains the row ' +
      'and unit configuration unless purgeData is true, and clears any staged update. The loaded module keeps running ' +
      'until restart but is no longer served; restartRequired records that. Bundled plugins refuse with 409.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was already uninstalled' })
  @ApiResponse({ status: Http.Conflict, description: 'Bundled plugins cannot be uninstalled' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/uninstall')
  uninstall(@Param('slug') slug: string, @Body() dto: UninstallPluginDto) {
    return from(
      this.lifecycle.uninstall({ slug, actorId: this.abilityService.getActingUserId(), purgeData: dto.purgeData }),
    ).pipe(
      map(({ plugin, affectedUnits }) => ({
        message: t('success.plugin.uninstalled', { slug }),
        plugin,
        affectedUnits,
      })),
    );
  }

  // ─── Update consent (#321): the C3 seam's first caller ────────────────────

  @ApiOperation({
    summary: 'Approve the staged pending update',
    description:
      'The server-scope consent act: seeds the new server-consentable grants, re-stamps risk-escalated ones, ' +
      'applies the declares[] catalog diff, and suspends household/user units owing a fresh decision (reported ' +
      'per axis on the response). Activation is DB-side — the running instance keeps the prior code until the ' +
      'next restart (restartRequired). Enforcement of the confirmation sets stays in the service; the 409 ' +
      'challenge bodies carry the prompt inputs to re-submit verbatim.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({
    status: Http.Gone,
    description:
      'Plugin was uninstalled — possibly while this update sat pending: an uninstall committing mid-decision ' +
      'rolls the approval back whole, so read this as "uninstalled while you were deciding", not "not found"',
  })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'No pending update; or a challenge: Critical confirmation required (expectedSlugs), or activation is ' +
      'blocked by a durable denial (deniedRequiredSlugs)',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'Stored PENDING manifest failed re-validation (a corrupt ACTIVE manifest renders as 500 by design)',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/update/approve')
  approveUpdate(@Param('slug') slug: string, @Body() dto: ApprovePluginUpdateDto) {
    return from(
      this.updates.approve({
        slug,
        approverId: this.abilityService.getActingUserId(),
        confirmCriticalSlugs: dto.confirmCriticalSlugs,
      }),
    ).pipe(
      map((result) => ({
        message: t('success.plugin.update_approved', { slug, version: result.plugin.version }),
        plugin: result.plugin,
        comparison: result.comparison,
        seededGrants: result.seededGrants,
        // Also on the row, surfaced top-level because it is the response's
        // one operational instruction: nothing serves the new code until a
        // restart.
        restartRequired: result.plugin.restartRequired,
        suspendedHouseholdUnits: result.suspendedHouseholdUnits,
        suspendedUserUnits: result.suspendedUserUnits,
      })),
    );
  }

  @ApiOperation({
    summary: 'Reject the staged pending update',
    description:
      'Clears the pending columns and emits plugin.update_rejected — the #84 distribution pipeline keys staged-file ' +
      'cleanup off that event; this endpoint never touches the filesystem.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({ status: Http.Conflict, description: 'No pending update to reject' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/update/reject')
  rejectUpdate(@Param('slug') slug: string) {
    return from(this.updates.reject({ slug, rejectorId: this.abilityService.getActingUserId() })).pipe(
      map((plugin) => ({ message: t('success.plugin.update_rejected', { slug }), plugin })),
    );
  }

  @ApiOperation({
    summary: 'Present the staged pending update for approval',
    description:
      "The approval screen's data source: the escalation comparison recomputed against today's decisions " +
      '(escalations, serverGating, blockedByDenial), pendingSince, the declares[] catalog diff approving would ' +
      "apply (added/removed plugin-namespaced permissions — removed takes their grants), and the staged manifest's " +
      'consent surface localized for the requester. A durable denial renders as blockedByDenial state here; only ' +
      'approve refuses over it.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({ status: Http.Conflict, description: 'No pending update is staged' })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'Stored PENDING manifest failed re-validation (a corrupt ACTIVE manifest renders as 500 by design)',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Plugin))
  // The approval screen is mutation-adjacent by definition — it exists to be
  // read right before approve/reject, and the comparison is recomputed
  // against TODAY's decisions. Serving it from the response cache would hand
  // the admin the very staleness the recompute exists to prevent.
  @NoCache()
  @Get(':slug/update/pending')
  pendingUpdate(@Param('slug') slug: string) {
    return from(this.loadPendingPresentation(slug));
  }

  // ─── Per-feature activation state (#354): the D-BX server axis ───────────

  @ApiOperation({
    summary: 'Per-feature activation state for the Server unit (#60)',
    description:
      'Why a feature is or is not running server-wide: per-feature active|disabled with a denied|pending reason ' +
      'paired with the blocking permission slugs. `perUnitSlugs` matters most from this viewpoint — the ' +
      'household/user-consented checks a server answer does NOT determine, so `active` here reads as "the gates ' +
      'this viewpoint owns are open", never as a fleet-wide green.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Plugin))
  // Consent decisions must be visible on the next read (#60 keeps this
  // surface uncached) — and the response cache keys without the resolved
  // locale (#358), which would cross-serve localized bodies.
  @NoCache()
  @Get(':slug/features')
  featureStates(@Param('slug') slug: string) {
    // No scope refusal to make here, unlike the household axis: the
    // household-viewpoint-on-server-scope rule is
    // `scope === Server && unit.scopeType === 'Household'`, so a Server unit
    // passes it at any plugin scope. The 404/410 pair and the guards that
    // bracket the derivation both come from the slug entry point.
    return from(
      this.featureState.resolveForUnitBySlug(slug, SERVER_PLUGIN_UNIT, this.auditContext.getLocale() ?? undefined),
    ).pipe(map((featureState) => ({ featureState })));
  }

  /**
   * The read's composition: `describePending` draws the 404/410/409
   * distinctions and recomputes the comparison; the presentation service
   * renders the staged manifest's check surface for the Server unit,
   * localized from CLS — from the SAME row describePending loaded, so the
   * comparison and the consent surface describe one staging by
   * construction, whatever resolves or re-stages concurrently.
   *
   * The row is the only shared snapshot, deliberately. A grant decision
   * landing between describePending's comparison and the presentation's own
   * grant read can still leave `blockedByDenial` disagreeing with a check's
   * decision state. That window is cosmetic and self-limiting: approve
   * recomputes the comparison against TODAY's decisions and refuses over a
   * denial regardless of what this screen rendered, so a stale screen
   * cannot authorize anything — and closing it would mean one transaction
   * threaded through the presentation service, a cross-service seam that is
   * not worth a body re-derived on the next action.
   */
  private async loadPendingPresentation(slug: string): Promise<Record<string, unknown>> {
    const description = await this.updates.describePending(slug);
    // Presented FROM the row describePending loaded, never re-read: a
    // re-read opens a window in which the staged update resolves and is
    // replaced — possibly under the SAME version, which no equality check
    // can detect — and the body would mix two updates. One snapshot makes
    // the comparison and the consent surface consistent by construction.
    const presentation = await this.presentation.presentPendingFromRow(
      description.plugin,
      SERVER_PLUGIN_UNIT,
      this.auditContext.getLocale() ?? undefined,
    );

    // Unreachable in practice — describePending threw for every state that
    // makes the presentation null — but the null contract is the
    // presentation service's, and mapping it beats a non-null assertion.
    if (presentation === null) {
      throw new PluginUpdateNoPendingError(slug);
    }

    return {
      activeVersion: description.plugin.version,
      pendingVersion: description.plugin.pendingVersion,
      pendingSince: description.pendingSince,
      escalations: description.comparison.escalations,
      serverGating: description.comparison.serverGating,
      blockedByDenial: description.comparison.blockedByDenial,
      // The catalog diff approving would apply. Separate from `escalations`
      // because no escalation kind describes a declaration change, and a
      // declaration the plugin never requests appears in neither the checks
      // nor the escalations — `removed` is the destructive half of approving,
      // and the screen has to be able to say so.
      declares: description.declares,
      // The plugin envelope ({id, slug, enabled}) rides inside — one wire
      // name for one fact.
      presentation,
    };
  }
}
