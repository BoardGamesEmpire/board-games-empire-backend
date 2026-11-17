import { AuditContextService, SERVER_PLUGIN_UNIT } from '@bge/actor-context';
import { Action, ResourceType, roleLoading } from '@bge/database';
import { SupportedLocalesService, t } from '@bge/i18n';
import { AbilityService, CheckPolicies, PoliciesGuard, ScopeComposer, Unscoped } from '@bge/permissions';
import {
  PluginConsentPresentationNotFoundError,
  PluginConsentPresentationService,
  PluginFeatureStateNotFoundError,
  PluginFeatureStateService,
  PluginInventoryNotFoundError,
  PluginInventoryService,
  PluginLifecycleNotFoundError,
  PluginLifecycleService,
  PluginServerConsentActService,
  PluginUnitPluginNotFoundError,
  PluginUpdateNoPendingError,
  PluginUpdatePluginNotFoundError,
  PluginUpdateService,
  restartProcessRoles,
} from '@bge/plugin';
import { PluginArtifactStager, type PluginArtifactStagingResult } from '@bge/plugin-artifacts';
import { paginated, PaginatedResponseDto } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { consentActLocale } from './consent-act-locale';
import {
  actSummary,
  ApprovePluginUpdateDto,
  ApprovePluginUpdateResponseDto,
  ListPluginsQueryDto,
  PluginInventoryDetailResponseDto,
  PluginInventoryEntryDto,
  RejectPluginUpdateDto,
  ReviewConsentDto,
  serverConsentActResponse,
  ServerConsentActResponseDto,
  StagePluginUpdateDto,
  StagePluginUpdateResponseDto,
  ToggleConsentDto,
  UninstallPluginDto,
  UpdatePluginConfigDto,
} from './dto';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';
import { canReadServerPlugins, SERVER_PLUGIN_COLUMN } from './policies/read-server-plugins.policy';

const PaginatedPluginsResponse = PaginatedResponseDto(PluginInventoryEntryDto, 'plugins');

/**
 * The server list's set is every installed plugin, so it names no scope of
 * its own. The reason is a claim about the catalog, checked beside the
 * controller's spec: a reach that is neither of these two would make it false.
 *
 * Its ceiling is built from the rules that read {@link SERVER_PLUGIN_COLUMN},
 * the column its gate asks about. A caller can pass the gate on one rule and
 * hold `read:plugin:installed` beside it: a key with `read:plugin` pinned to
 * one plugin, say. Built from every rule, the ceiling would admit every
 * plugin's server columns through the grant the gate refuses.
 */
export const SERVER_PLUGIN_LIST_SCOPE = Unscoped(
  'every installed plugin: the roles past the column gate read every row, and the one fixed filter, ' +
    "read:plugin:installed, is every user's and leaves out the column the gate and the ceiling ask about",
);

/**
 * Server-level plugin lifecycle (#59 Phase C4, #320): the admin's
 * enable/disable switch, the server config write, and uninstall. Plugins
 * are addressed by slug at the HTTP edge; toggles are POST verb sub-paths
 * per house style, and uninstall is a POST rather than a DELETE because the
 * resource tombstones (410 afterward) instead of disappearing — and
 * `purgeData` belongs in a body, which DELETE should not carry.
 *
 * The coarse `manage:plugin` CASL gate lives here; the service seam
 * re-verifies the acting user's server-admin authority and owns every domain
 * rule. The seam never sees an API key, so a key's scope is checked here. The
 * reads gate on {@link canReadServerPlugins} rather than a bare type check,
 * which every user's identity-column grant would pass. Actor
 * identity is resolved from CLS at this edge and passed into the runtime
 * input — never read from a request body.
 *
 * A type-level gate passes a key's rule whatever plugin it names, and the
 * services read by slug alone. So each route addressed by slug first resolves
 * its slug under the actor's ceiling, `read` for the reads and `manage` for
 * the writes, and answers a slug outside it as not installed (#789, #978): a
 * key scoped to one plugin reads and writes that plugin and no other.
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
    private readonly presentation: PluginConsentPresentationService,
    private readonly featureState: PluginFeatureStateService,
    private readonly inventory: PluginInventoryService,
    private readonly serverConsentActs: PluginServerConsentActService,
    private readonly auditContext: AuditContextService,
    private readonly scopeComposer: ScopeComposer,
    private readonly supportedLocales: SupportedLocalesService,
    private readonly stager: PluginArtifactStager,
  ) {}

  // ─── Installed-plugin inventory (#354) ────────────────────────────────────

  @ApiOperation({
    summary: 'List the plugins installed on this server',
    description:
      "The plugin management screen's first read, and the only plugin read that answers before a slug is known: " +
      'installed set, server enablement, restart-required and staged-update state, and where each plugin ' +
      'artifact came from. Paginated per #230 — `?page=` (1-based) and `?limit=`, with a `pagination` ' +
      'envelope. Tombstoned plugins are excluded unless `?includeUninstalled=true`. A plugin whose stored ' +
      'manifest cannot be read is still listed, marked `manifestUnreadable` with its localized fields null, ' +
      'rather than failing the page.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedPluginsResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies(canReadServerPlugins)
  // Must stay out of the response cache: read immediately after the lifecycle
  // writes that change it, which must be visible on the re-read.
  @Get()
  list(@Query() query: ListPluginsQueryDto) {
    return from(
      this.inventory.listForServer(
        query,
        () =>
          this.scopeComposer.compose(ResourceType.Plugin, Action.read, SERVER_PLUGIN_LIST_SCOPE, SERVER_PLUGIN_COLUMN),
        {
          includeUninstalled: query.includeUninstalled,
          locale: this.auditContext.getLocale() ?? undefined,
        },
      ),
    ).pipe(map((page) => paginated('plugins', page, query, ResourceType.Plugin)));
  }

  // ─── Consent surface (#322): Server scope ──────────────────────────────────

  @ApiOperation({
    summary: "Present the active manifest's consent surface for the Server unit",
    description:
      "The server admin's consent surface: every check the active manifest requests — riskLevel, required, " +
      'consentScope, localized reason, feature binding, and its decision state from this viewpoint (unit-scope ' +
      "checks read 'per-unit') — plus the localized features[] the checks group under.",
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies(canReadServerPlugins)
  // Must stay out of the response cache: it exists to be read right before a
  // consent act, and the act's writes must be visible on the re-read.
  @Get(':slug/consent')
  consentPresentation(@Param('slug') slug: string) {
    return from(
      this.assertUnderCeiling(slug, Action.read, PluginConsentPresentationNotFoundError).then(() =>
        this.presentation.presentForUnitBySlug(slug, SERVER_PLUGIN_UNIT, this.auditContext.getLocale() ?? undefined),
      ),
    ).pipe(map((presentation) => ({ presentation })));
  }

  // ─── Server consent acts (#1336) ───────────────────────────────────────────
  // A toggle and a review are each one recorded consent act for the Server
  // unit. Each answers 200 whether or not it changed anything (changed: false
  // and act: null when it did not), so repeating one is safe. Neither reads
  // the Server switch: consenting before the plugin is switched on is a
  // legitimate order.

  @ApiOperation({
    summary: 'Grant or refuse one optional server-scope requested permission',
    description:
      'One consent act for the Server unit that changes the answer to one optional requested permission the ' +
      "server decides, as the active manifest's consent surface (GET …/consent) showed it. A required " +
      'permission cannot be toggled: the server admin refuses one by switching the plugin off or uninstalling ' +
      'it. Repeating the current answer answers changed: false.',
  })
  @ApiResponse({ status: Http.Ok, type: ServerConsentActResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'You are not a server admin' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'The plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'PLUGIN_CONSENT_ACT_STALE: the plugin or the permission risk changed since the consent surface was read; ' +
      'read it again and answer again. PLUGIN_CONSENT_ACT_UNGRANTABLE: the permission cannot be granted.',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'PLUGIN_CONSENT_ACT_ANSWER: the permission is not requested, is required, or is not decided by the ' +
      'server (rule says which). PLUGIN_CONSENT_ACT_LOCALE: locale is not one this server supports. Also a body ' +
      'that fails validation.',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/consent/toggle')
  toggleConsent(@Param('slug') slug: string, @Body() dto: ToggleConsentDto) {
    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginUnitPluginNotFoundError).then(() =>
        this.serverConsentActs.toggle({
          slug,
          actorId: this.abilityService.getActingUserId(),
          manifestSha256: dto.manifestSha256,
          answers: [dto.answer],
          locale: this.presentationLocale(dto.locale),
        }),
      ),
    ).pipe(map((result) => serverConsentActResponse(t('success.plugin.server_consent_toggled', { slug }), result)));
  }

  @ApiOperation({
    summary: 'Accept what the active manifest still asks of the server',
    description:
      'One consent act for the Server unit that grants the server-scope requested permissions the active ' +
      'manifest leaves outstanding, most often one whose risk rose since it was granted. A server review only ' +
      'grants: an optional permission is refused with a toggle, and a required one by switching the plugin off ' +
      'or uninstalling it. To consent to a staged update, approve it. Sending the same review again answers ' +
      'changed: false.',
  })
  @ApiResponse({ status: Http.Ok, type: ServerConsentActResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'You are not a server admin' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'The plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'PLUGIN_CONSENT_ACT_STALE: the plugin or a permission risk changed since the consent surface was read; ' +
      'read it again and answer again. PLUGIN_CONSENT_ACT_UNGRANTABLE: a permission answered Granted cannot be ' +
      'granted.',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'PLUGIN_CONSENT_ACT_ANSWER: an answer refuses a permission (rule server-refusal), or does not match what ' +
      'the server decides (rule and permissionSlugs say which). PLUGIN_CONSENT_ACT_LOCALE: locale is not one ' +
      'this server supports. Also a body that fails validation, such as an empty answers list.',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/consent/review')
  reviewConsent(@Param('slug') slug: string, @Body() dto: ReviewConsentDto) {
    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginUnitPluginNotFoundError).then(() =>
        this.serverConsentActs.review({
          slug,
          actorId: this.abilityService.getActingUserId(),
          manifestSha256: dto.manifestSha256,
          answers: dto.answers,
          locale: this.presentationLocale(dto.locale),
        }),
      ),
    ).pipe(map((result) => serverConsentActResponse(t('success.plugin.server_consent_reviewed', { slug }), result)));
  }

  @ApiOperation({ summary: 'Enable a plugin (server-level switch)' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/enable')
  enable(@Param('slug') slug: string) {
    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginLifecycleNotFoundError).then(() =>
        this.lifecycle.enable({ slug, actorId: this.abilityService.getActingUserId() }),
      ),
    ).pipe(map((plugin) => ({ message: t('success.plugin.enabled', { slug }), plugin })));
  }

  @ApiOperation({ summary: 'Disable a plugin (server-level switch)' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/disable')
  disable(@Param('slug') slug: string) {
    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginLifecycleNotFoundError).then(() =>
        this.lifecycle.disable({ slug, actorId: this.abilityService.getActingUserId() }),
      ),
    ).pipe(map((plugin) => ({ message: t('success.plugin.disabled', { slug }), plugin })));
  }

  @ApiOperation({
    summary: 'Replace the server-scope plugin configuration',
    description:
      "Validates the payload against the manifest's config.schema (422 with issues[] on violation), persists it, " +
      'and triggers the config hot-reload. Last-writer-wins between two writes; a plugin manifest replaced ' +
      'mid-request is refused with 409.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({ status: Http.UnprocessableEntity, description: 'Configuration violates the declared schema' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'The active plugin manifest was replaced mid-request — an activation or a reinstall, not necessarily at a ' +
      'new version — so the document was judged against the old schema; reload and retry',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @Patch(':slug/config')
  updateConfig(@Param('slug') slug: string, @Body() dto: UpdatePluginConfigDto) {
    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginLifecycleNotFoundError).then(() =>
        this.lifecycle.updateConfig({ slug, actorId: this.abilityService.getActingUserId(), config: dto.config }),
      ),
    ).pipe(map((plugin) => ({ message: t('success.plugin.config_updated', { slug }), plugin })));
  }

  @ApiOperation({
    summary: 'Uninstall a plugin (tombstone)',
    description:
      'Purges all consent (grants and the declared-permission catalog — reinstall is fresh consent), retains the row ' +
      'and unit configuration unless purgeData is true, and clears any staged update. The loaded module keeps running ' +
      'until restart but is no longer served; restartRequired records that.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was already uninstalled' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/uninstall')
  uninstall(@Param('slug') slug: string, @Body() dto: UninstallPluginDto) {
    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginLifecycleNotFoundError).then(() =>
        this.lifecycle.uninstall({ slug, actorId: this.abilityService.getActingUserId(), purgeData: dto.purgeData }),
      ),
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
    summary: 'Stage an update of a plugin from a posted plugin artifact, by its checksum',
    description:
      'Stages the plugin artifact the checksum names, posted earlier, as an update of this plugin, with the ' +
      'confirmations its read asked for (#1096). An update that needs nothing from the server admin is activated ' +
      'at once; otherwise it is a staged update that waits for an update approval. Either way the answer is 200, ' +
      'and `activated` says which. The plugin comes back as the inventory serves it, so a staged update shows ' +
      'with the stagingId an update approval or a rejection names. Sending it again once it is done, as a retry ' +
      'or a double click does, answers with what is recorded and changes nothing. A wrong or missing ' +
      'acknowledgement is a 409 challenge carrying what it expected.',
  })
  @ApiOkResponse({ type: StagePluginUpdateResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Insufficient permissions, or the update requests a permission no plugin may have',
  })
  @ApiResponse({
    status: Http.NotFound,
    description:
      "Plugin not installed, or outside the actor's ceiling; or no plugin artifact with this checksum is waiting",
  })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'A forbidden import was not acknowledged exactly; the plugin artifact carries the version the plugin runs; ' +
      'the plugin already has a staged update, which an update approval or a rejection must answer first; the ' +
      'plugin artifact is for another plugin; another plugin artifact became active while the update was being ' +
      'staged (PluginUpdateActiveArtifactMovedError — stage it again); or the update would be activated at once ' +
      'and another DataGateway already has the name its DataGateway would take',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: "The update's plugin manifest is not valid, or requests a core permission that does not exist",
  })
  @ApiResponse({
    status: Http.ServiceUnavailable,
    description: 'Static analysis is unavailable on this server; an operator must fix the parser installation',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/update/stage')
  stageUpdate(@Param('slug') slug: string, @Body() dto: StagePluginUpdateDto) {
    const locale = this.auditContext.getLocale() ?? undefined;

    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginUpdatePluginNotFoundError)
        .then(() =>
          this.stager.stage({
            slug,
            sha256: dto.sha256,
            actorId: this.abilityService.getActingUserId(),
            acknowledgeForbiddenImports: dto.acknowledgeForbiddenImports,
            deepScan: dto.deepScan,
          }),
        )
        // Read back through the inventory, as the install route reads a new
        // plugin, so a client gets one shape for it (#1096).
        .then(async (staging) => ({ staging, plugin: await this.inventory.getBySlug(slug, locale) })),
    ).pipe(
      map(({ staging, plugin }) => ({
        message: this.stagingMessage(slug, staging),
        activated: staging.activated,
        plugin,
        dataGatewayNameConflict: staging.dataGatewayNameConflict,
      })),
    );
  }

  @ApiOperation({
    summary: 'Approve the staged pending update',
    description:
      "The Server unit's consent to the staged update, recorded as one UpdateApprove consent act (act on the " +
      "response). It grants every server-scope permission the new manifest requires, at today's risk, a denied " +
      'one included: approving a version that requires a permission consents to it. It also grants each optional ' +
      'server-scope permission the Server unit has not decided, and leaves an optional decision that exists as it ' +
      'stands. It applies the declares[] catalog diff, and reports the household and user units owing a fresh decision per axis on the ' +
      'response (reconsentHouseholdUnits, reconsentUserUnits). Those units keep whatever they were running: one ' +
      'owing a required permission reads review_pending until its owner decides, and one owing only a risk-raised ' +
      'optional permission has that feature off (#1149). Activation is DB-side — the running instance keeps the prior code until the ' +
      'next restart (restartRequired). Enforcement of the confirmation sets stays in the service; the 409 ' +
      'challenge bodies carry the prompt inputs to re-submit verbatim. The body names the staging it answers with ' +
      'the stagingId the staged-update read reported (#357).',
  })
  @ApiOkResponse({ type: ApprovePluginUpdateResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({
    status: Http.Gone,
    description:
      'Plugin was uninstalled — possibly while this update sat pending: an uninstall committing mid-decision ' +
      'rolls the approval back whole, so read this as "uninstalled while you were deciding", not "not found"',
  })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'No staged update; the staging named by stagingId was replaced since it was read ' +
      '(PluginUpdateStagingReplacedError — read it again); or a challenge: Critical confirmation required ' +
      '(expectedSlugs, every Critical permission the approval newly confers, a denied one included); or the ' +
      'update makes the plugin a data-gateway plugin and another DataGateway already has the name its DataGateway would take ' +
      '(dataGatewayName — rename that DataGateway, then approve again)',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'Stored PENDING manifest failed re-validation (a corrupt ACTIVE manifest renders as 500 by design), or ' +
      'PLUGIN_CONSENT_ACT_LOCALE: locale is not one this server supports',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/update/approve')
  approveUpdate(@Param('slug') slug: string, @Body() dto: ApprovePluginUpdateDto) {
    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginUpdatePluginNotFoundError).then(() =>
        this.updates.approve({
          slug,
          approverId: this.abilityService.getActingUserId(),
          stagingId: dto.stagingId,
          shownRisks: dto.shownRisks,
          confirmCriticalSlugs: dto.confirmCriticalSlugs,
          // The locale the staged-update read was requested in, which the
          // approval's consent act records its presentation in (#1336, #1301).
          locale: this.presentationLocale(dto.locale),
        }),
      ),
    ).pipe(
      map((result) => ({
        // Activation always owes a restart, so the process role that loads
        // the plugin is the one to name (#1096).
        message: t('success.plugin.update_approved', {
          slug,
          version: result.plugin.version,
          processRole: roleLoading(result.plugin.category),
        }),
        plugin: result.plugin,
        comparison: result.comparison,
        act: actSummary(result.act),
        seededGrants: result.seededGrants,
        // Also on the row, surfaced top-level because it is the response's
        // one operational instruction: nothing serves the new code until a
        // restart.
        restartRequired: result.plugin.restartRequired,
        restartProcessRoles: restartProcessRoles(result.plugin),
        reconsentHouseholdUnits: result.reconsentHouseholdUnits,
        reconsentUserUnits: result.reconsentUserUnits,
      })),
    );
  }

  @ApiOperation({
    summary: 'Reject the staged pending update',
    description:
      'Clears the staged-update columns and emits plugin.update_rejected. Consent that households and users ' +
      'gave to this staged update ahead of time (pre-consent) is deleted with it, one plugin.grant_revoked ' +
      'each, so a later update that requests the same permission asks again. The staged plugin artifact stays on ' +
      'disk until the plugin artifact sweep (#1094), which runs at boot and every hour, removes it: no living ' +
      'plugin names it, and no running plugin was loaded from it; ' +
      'this endpoint never touches the filesystem. The body names the staging it answers with the stagingId the ' +
      'staged-update read, or the plugin read, reported (#357).',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'No staged update to reject, or the staging named by stagingId was replaced since it was read ' +
      '(PluginUpdateStagingReplacedError — read it again)',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.Plugin))
  @HttpCode(Http.Ok)
  @Post(':slug/update/reject')
  rejectUpdate(@Param('slug') slug: string, @Body() dto: RejectPluginUpdateDto) {
    return from(
      this.assertUnderCeiling(slug, Action.manage, PluginUpdatePluginNotFoundError).then(() =>
        this.updates.reject({ slug, rejectorId: this.abilityService.getActingUserId(), stagingId: dto.stagingId }),
      ),
    ).pipe(map((plugin) => ({ message: t('success.plugin.update_rejected', { slug }), plugin })));
  }

  @ApiOperation({
    summary: 'Present the staged pending update for approval',
    description:
      "The approval screen's data source: the escalation comparison recomputed against today's decisions " +
      '(escalations, serverGating, deniedRequiredSlugs), pendingSince, stagingId (which approve and reject send back, ' +
      'so neither answers a staging the admin was not shown, #357), the declares[] catalog diff approving would ' +
      'apply (added/removed plugin-namespaced permissions — approving deletes the catalog rows of removed ones), ' +
      'noLongerRequested (the requested permissions the update stops requesting, whose consent decisions stop ' +
      'conferring), ' +
      "and the staged manifest's " +
      'consent surface localized for the requester. Approving deletes no consent decision: one on a removed or ' +
      'no longer requested permission is kept and confers nothing until a later update requests the permission ' +
      'at its scope again. deniedRequiredSlugs lists the server-scope permissions the ' +
      'update requires that the Server unit denied: approving grants them. unitCoverage gives, for the household ' +
      'and the user scope, switchedOn (units with the plugin switched on) and covered (those of them approving ' +
      'would ask nothing of, such as a household that already accepted the staged update); the rest are told ' +
      'they owe re-consent when the update is approved.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({ status: Http.Conflict, description: 'No pending update is staged' })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'Stored PENDING manifest failed re-validation (a corrupt ACTIVE manifest renders as 500 by design)',
  })
  @CheckPolicies(canReadServerPlugins)
  // The approval screen must stay out of the response cache — it exists to be
  // read right before approve/reject, and the comparison is recomputed
  // against TODAY's decisions. Serving it from the response cache would hand
  // the admin the very staleness the recompute exists to prevent.
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
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies(canReadServerPlugins)
  // Must stay out of the response cache: consent decisions must be visible on
  // the next read (#60).
  @Get(':slug/features')
  featureStates(@Param('slug') slug: string) {
    // The slug is resolved under the actor's ceiling first, as on every slug
    // route (#789). Past that there is no plugin-scope refusal to make here,
    // unlike the household axis: the household-viewpoint-on-server-scope rule
    // is `scope === Server && unit.scopeType === 'Household'`, so a Server
    // unit passes it at any plugin scope. For a slug under the ceiling, the
    // 404/410 pair and the guards that bracket the derivation come from the
    // slug entry point.
    return from(
      this.assertUnderCeiling(slug, Action.read, PluginFeatureStateNotFoundError).then(() =>
        this.featureState.resolveForUnitBySlug(slug, SERVER_PLUGIN_UNIT, this.auditContext.getLocale() ?? undefined),
      ),
    ).pipe(map((featureState) => ({ featureState })));
  }

  // ─── Single installed plugin (#354) ───────────────────────────────────────
  // Declared LAST deliberately. Every other route on this controller lives
  // under `:slug/<literal>`, so none can be shadowed by a one-segment
  // parametric path today — but a future single-segment LITERAL GET (say
  // `@Get('summary')`) declared after this one would be swallowed by `:slug`
  // and never reached. Keeping the catch-all at the bottom makes that
  // ordering structural instead of a comment somebody has to find.

  @ApiOperation({
    summary: 'One installed plugin, with its manifest detail',
    description:
      'The list entry plus what a page has no room for: the effective execution mode and the localized ' +
      'features[] the plugin declares. A tombstoned plugin is 410 here unconditionally — the ' +
      '`includeUninstalled` flag is a LIST filter and has no counterpart on this route, because a flag able to ' +
      'turn a 410 into a 200 would make one route report two statuses for identical state. Unlike the list, a ' +
      'stored manifest that cannot be read is a 500: the unreadable row is the entire response, and there is ' +
      'nothing left worth serving.',
  })
  @ApiResponse({ status: Http.Ok, type: PluginInventoryDetailResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: "Plugin not installed, or outside the actor's ceiling" })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies(canReadServerPlugins)
  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return from(
      this.assertUnderCeiling(slug, Action.read, PluginInventoryNotFoundError).then(() =>
        this.inventory.getBySlug(slug, this.auditContext.getLocale() ?? undefined),
      ),
    ).pipe(map((plugin) => ({ plugin })));
  }

  /**
   * Resolves the route's slug under the actor's ceiling, before the route's
   * service runs (#789, #978).
   *
   * The gates here are type-level, so a key whose scope names one plugin
   * passes them on every slug, and the services read by slug alone. This
   * reads the slug under the actor's ceiling, with the slug as its scope, and
   * refuses a slug outside it with the route's own not-found error: the same
   * 404 and code as a slug never installed, so a key cannot tell which
   * plugins exist beyond its scope. It runs first, so a staged update or an
   * uninstalled plugin outside the scope answers 404, never the 409 or 410
   * its service would draw, and a write's seam is never reached.
   *
   * A read composes the ceiling the server list does, from the rules that
   * read the column its gate asks about. A write serves no column, so every
   * `manage` rule counts. Admin's rules carry no conditions, so the ceiling
   * admits every row, uninstalled plugins included, and the services draw
   * their own answers as before.
   */
  private async assertUnderCeiling(
    slug: string,
    action: typeof Action.read | typeof Action.manage,
    notFound: new (slug: string) => Error,
  ): Promise<void> {
    const underCeiling = await this.inventory.existsUnderCeiling(slug, (scope) =>
      this.scopeComposer.compose(
        ResourceType.Plugin,
        action,
        scope,
        action === Action.read ? SERVER_PLUGIN_COLUMN : undefined,
      ),
    );

    if (!underCeiling) {
      throw new notFound(slug);
    }
  }

  /**
   * The staging's message, stating what the row the staging produced or found
   * shows rather than an event (#1096): a row can owe a restart for another
   * reason, and a repeated request can find no restart owed at all, so the
   * activated message says the version is active and names a process role
   * only when one is owed a restart.
   */
  private stagingMessage(slug: string, { plugin, activated }: PluginArtifactStagingResult) {
    if (!activated) {
      // Unreachable in practice: the stager answers a staged update only from
      // a row that holds one, and the staged columns are set as one set. A
      // row without its version is mapped rather than interpolated.
      if (plugin.pendingVersion === null) {
        throw new PluginUpdateNoPendingError(slug);
      }

      return t('success.plugin.update_staged', { slug, version: plugin.pendingVersion });
    }

    const [processRole] = restartProcessRoles(plugin);
    if (processRole === undefined) {
      return t('success.plugin.update_already_active', { slug, version: plugin.version });
    }

    return t('success.plugin.update_activated', { slug, version: plugin.version, processRole });
  }

  /**
   * The read's composition: `describePending` draws the 404/410/409
   * distinctions and recomputes the comparison; the presentation service
   * renders the staged manifest's check surface for the Server unit,
   * localized from CLS — from the SAME row describePending loaded, so the
   * comparison and the consent surface describe one staging by
   * construction, whatever resolves or re-stages concurrently.
   *
   * The row is the only shared snapshot, deliberately. A consent decision
   * landing between describePending's comparison and the presentation's own
   * grant read can still leave `deniedRequiredSlugs` disagreeing with a
   * check's decision state. That window is cosmetic and self-limiting:
   * approve works out what it grants, and the Critical confirmation it asks,
   * from the decisions read inside its own transaction, whatever this screen
   * rendered, so a stale screen cannot authorize anything — and closing it
   * would mean one transaction threaded through the presentation service, a
   * cross-service seam that is not worth a body re-derived on the next action.
   */
  private async loadPendingPresentation(slug: string): Promise<Record<string, unknown>> {
    await this.assertUnderCeiling(slug, Action.read, PluginUpdatePluginNotFoundError);

    const description = await this.updates.describePending(slug);
    // Presented FROM the row describePending loaded, never re-read: a
    // re-read opens a window in which the staged update resolves and is
    // replaced — possibly by the SAME version from the same artifact, which
    // only the staging id tells apart (#357) — and the body would mix two
    // updates. One snapshot makes
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
      // What approve and reject send back (#357): an answer naming a staging
      // that has since been replaced is refused instead of applied to it.
      stagingId: description.plugin.pendingStagingId,
      escalations: description.comparison.escalations,
      serverGating: description.comparison.serverGating,
      deniedRequiredSlugs: description.comparison.deniedRequiredSlugs,
      // Per scope, the units with the plugin switched on and those approving
      // would ask nothing of, by the same rule activation uses to decide who
      // owes re-consent (#1336): the rest are the units the approval reports
      // as owing.
      unitCoverage: description.unitCoverage,
      // The catalog diff approving would apply. Separate from `escalations`
      // because no escalation kind describes a declaration change, and a
      // declaration the plugin never requests appears in neither the checks
      // nor the escalations — approving deletes the catalog rows of `removed`,
      // and the screen has to be able to say so.
      declares: description.declares,
      // The requested permissions approving stops requesting (#577). Their
      // consent decisions are kept and stop conferring until a later update
      // requests them at their scope again (#1152). The staged consent
      // surface only omits them, and an omission is not a warning.
      noLongerRequested: description.noLongerRequested,
      // The DataGateway name the update would take, when another holds it:
      // the update approval is refused until it is free (#1096).
      dataGatewayNameConflict: description.dataGatewayNameConflict,
      // The plugin envelope ({id, slug, enabled}) rides inside — one wire
      // name for one fact.
      presentation,
    };
  }

  /**
   * The locale a server write that stores a presentation renders it in
   * (#1301): the one the body names, refused unless this server supports it,
   * else the request's own. Each route calls it after its ceiling check, so a
   * plugin outside the actor's ceiling still answers as not installed.
   */
  private presentationLocale(named: string | undefined): string | undefined {
    return consentActLocale(
      named,
      this.supportedLocales.getSupportedTags(),
      this.auditContext.getLocale() ?? undefined,
    );
  }
}
