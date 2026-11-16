import { AuditContextService, requireSessionUserId, type UserPluginUnit } from '@bge/actor-context';
import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard, ScopeComposer } from '@bge/permissions';
import {
  PluginConsentActService,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginInventoryService,
  PluginUnitLifecycleService,
  type ConsentActAnswer,
  type ConsentActInput,
} from '@bge/plugin';
import { DefaultPaginationQueryDto, paginated, PaginatedResponseDto } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  consentActResponse,
  ConsentActResponseDto,
  ConsentSurfaceQueryDto,
  ConsentSurfaceResponseDto,
  PluginUnitInventoryEntryDto,
  ReviewConsentDto,
  SwitchOnUserPluginDto,
  ToggleConsentDto,
} from './dto';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';

const PaginatedUserPluginsResponse = PaginatedResponseDto(PluginUnitInventoryEntryDto, 'plugins');

/**
 * User-scope plugin consent (#59 Phase C4, #322): each user's own consent
 * acts (#1150) and the consent surface they answer. #323 adds the unit
 * enable/disable endpoints to this class. Self-addressed under `/users/me`
 * per D-AX — the acting user from CLS is BOTH the decider and the consent
 * unit, so no one else's unit is addressable. No permission seed exists for
 * deciding on this axis (#59's C4 seeded only the server and household pairs).
 * The list is the one read with a seed: it composes the caller's ceiling on
 * `Plugin`, which every user holds through `read:plugin:installed`, so it
 * alone carries a policy gate.
 *
 * With no seed for the rest, PoliciesGuard has nothing to clamp an API key's
 * floor on — so the gate here is the actor KIND, on every route, the list's
 * too: user-scope consent is "decided by the
 * user themself" (#225's predicate taken literally), and an API key is an
 * agent acting AS its owner, not the owner. Without this, a key minted with
 * any unrelated scope could record consent to third-party code and create
 * the owner's enablement anchor — authority the key was never scoped to.
 */
@ApiBearerAuth()
@UseFilters(PluginExceptionFilter)
@ApiTags('user-plugins')
@Controller('users/me/plugins')
export class UserPluginsController {
  constructor(
    private readonly consentActs: PluginConsentActService,
    private readonly presentation: PluginConsentPresentationService,
    private readonly units: PluginUnitLifecycleService,
    private readonly featureState: PluginFeatureStateService,
    private readonly inventory: PluginInventoryService,
    private readonly auditContext: AuditContextService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  // ─── Installed-plugin inventory for the acting user (#354) ────────────────

  @ApiOperation({
    summary: 'List the plugins you can enable, with your own enablement state',
    description:
      'Every installed plugin, with no narrowing on the user axis: user-scope consent is legal at any plugin scope ' +
      '(#225), so unlike the household axis there is no plugin you cannot be anchored on. `unit.anchored` is ' +
      'false until you switch the plugin on, which creates your unit enablement — which is why an empty enablement ' +
      'history shows a populated list of not-yet-enabled plugins rather than nothing. `unit.state` is the stable ' +
      'unit state code and `unit.consent` the consent standing behind it. `unit.dormancy` is null unless the ' +
      "plugin's stored manifest cannot be read, when it is unavailable. Carries no version, provenance or " +
      'install history, and never tombstones: this surface exists to decide your own participation, not to ' +
      'inspect the server.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedUserPluginsResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'API keys cannot read a user consent surface, and nor can an actor with no read on plugins',
  })
  // The read composes the caller's `Plugin` ceiling, so an actor with no rule
  // on `Plugin` is refused rather than served an empty page.
  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Plugin))
  // Must stay out of the response cache: the grant, enable and disable writes
  // on this controller change these rows, and must be visible on the re-read.
  @Get()
  list(@Query() query: DefaultPaginationQueryDto) {
    return from(
      this.inventory.listForUser(
        this.selfUserId(),
        query,
        (scope) => this.scopeComposer.compose(ResourceType.Plugin, Action.read, scope),
        { locale: this.auditContext.getLocale() ?? undefined },
      ),
    ).pipe(map((page) => paginated('plugins', page, query, ResourceType.Plugin)));
  }

  @ApiOperation({
    summary: "Present the consent surface for your own unit: the active manifest's, or a staged update's",
    description:
      'Your consent surface: every requested permission, with your own decision state per permission — ' +
      "server-consented ones show the server's concrete state (one addressable decider), household-consented " +
      "ones read 'per-unit' (every household decides for itself) — plus riskLevel, required, grantable, localized " +
      'reason, and the localized features[] they group under. manifestSha256 names the plugin artifact presented, ' +
      'and stagedUpdate names an update waiting for the server admin. With manifest=staged it presents that ' +
      'update instead, so you can pre-consent; stagedOnly then marks what the active manifest does not request.',
  })
  @ApiResponse({ status: Http.Ok, type: ConsentSurfaceResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed, or (manifest=staged) no update waiting' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  // Must stay out of the response cache: read right before a consent act,
  // whose writes must be visible on the re-read (#1150).
  @Get(':slug/consent')
  consentPresentation(@Param('slug') slug: string, @Query() query: ConsentSurfaceQueryDto = {}) {
    const unit: UserPluginUnit = { scopeType: 'User', userId: this.selfUserId() };
    const locale = this.auditContext.getLocale() ?? undefined;

    // The staged consent surface lets the user pre-consent (#1150).
    return from(
      query.manifest === 'staged'
        ? this.presentation.presentStagedForUnitBySlug(slug, unit, locale)
        : this.presentation.presentForUnitBySlug(slug, unit, locale),
    ).pipe(map((presentation) => ({ presentation })));
  }

  // ─── Consent acts (#1150) and your own switch (#323) ───────────────────────
  // Switching on, toggling and reviewing are each one recorded consent act.
  // Each answers 200 whether or not it changed anything (changed: false and
  // act: null when it did not), so repeating one is safe.

  @ApiOperation({
    summary: 'Switch the plugin on for yourself, answering its requested permissions',
    description:
      'One consent act: you answer the requested permissions you decide for yourself, as the active ' +
      "manifest's consent surface (GET …/consent) showed them, and the plugin is switched on for you. A " +
      'switch-on names the active manifest only; to pre-consent to a staged update, send a review ' +
      '(POST …/consent/review) against the manifest=staged consent surface. Every required permission must be Granted; optional ones may be answered either ' +
      'way or left for later. manifestSha256 names the consent surface the answers were read from. Switching ' +
      'on again when nothing would change answers changed: false.',
  })
  @ApiResponse({ status: Http.Ok, type: ConsentActResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Only you can give consent for yourself: API keys and other non-user actors are refused',
  })
  @ApiResponse({ status: Http.NotFound, description: 'The plugin is not installed' })
  @ApiResponse({ status: Http.Gone, description: 'The plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'PLUGIN_CONSENT_ACT_STALE: the plugin or a permission risk changed since the consent surface was read; ' +
      'read it again and answer again. PLUGIN_CONSENT_ACT_UNGRANTABLE: a required permission cannot be granted ' +
      'here, which only a server admin can fix.',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'PLUGIN_CONSENT_ACT_REQUIRED_SET: a required permission was left out (missingSlugs) or Denied ' +
      '(refusedSlugs). PLUGIN_CONSENT_ACT_ANSWER: an answer does not match what the plugin asks for (rule and ' +
      'permissionSlugs say which). Also a body that fails validation.',
  })
  @HttpCode(Http.Ok)
  @Post(':slug/enable')
  enable(@Param('slug') slug: string, @Body() dto: SwitchOnUserPluginDto) {
    return from(this.consentActs.switchOn(this.actInput(slug, dto.manifestSha256, dto.answers))).pipe(
      map((result) => consentActResponse(t('success.plugin.enabled', { slug }), result)),
    );
  }

  @ApiOperation({
    summary: 'Grant or refuse one optional requested permission for yourself',
    description:
      'One consent act that changes your answer to one optional requested permission while the plugin is ' +
      'switched on for you. A required permission cannot be toggled: refusing one means switching the plugin ' +
      'off, or answering it in a review. Repeating your current answer answers changed: false.',
  })
  @ApiResponse({ status: Http.Ok, type: ConsentActResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Only you can give consent for yourself: API keys and other non-user actors are refused',
  })
  @ApiResponse({ status: Http.NotFound, description: 'The plugin is not installed' })
  @ApiResponse({ status: Http.Gone, description: 'The plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'PLUGIN_CONSENT_ACT_UNIT_OFF: the plugin is switched off for you; switch it on first. ' +
      'PLUGIN_CONSENT_ACT_STALE: the plugin or the permission risk changed since the consent surface was read. ' +
      'PLUGIN_CONSENT_ACT_UNGRANTABLE: the permission cannot be granted here.',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'PLUGIN_CONSENT_ACT_ANSWER: the permission is not requested, is required, or is not yours to decide ' +
      '(rule says which). Also a body that fails validation.',
  })
  @HttpCode(Http.Ok)
  @Post(':slug/consent/toggle')
  toggleConsent(@Param('slug') slug: string, @Body() dto: ToggleConsentDto) {
    return from(this.consentActs.toggle(this.actInput(slug, dto.manifestSha256, [dto.answer]))).pipe(
      map((result) => consentActResponse(t('success.plugin.consent_recorded', { slug }), result)),
    );
  }

  @ApiOperation({
    summary: 'Answer what the plugin, or its staged update, still asks you',
    description:
      'One consent act that answers the requested permissions the active manifest leaves outstanding for you, ' +
      'or, with the sha of a staged update, those the update adds (pre-consent). Refusing a required permission ' +
      'switches the plugin off for you in the same consent act, and the response says so (switchedOff: true). ' +
      'Sending that review again changes nothing and answers the same way.',
  })
  @ApiResponse({ status: Http.Ok, type: ConsentActResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Only you can give consent for yourself: API keys and other non-user actors are refused',
  })
  @ApiResponse({ status: Http.NotFound, description: 'The plugin is not installed' })
  @ApiResponse({ status: Http.Gone, description: 'The plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'PLUGIN_CONSENT_ACT_UNIT_OFF: the plugin is switched off for you. PLUGIN_CONSENT_ACT_STALE: the plugin, ' +
      'its staged update or a permission risk changed since the consent surface was read. ' +
      'PLUGIN_CONSENT_ACT_UNGRANTABLE: a permission answered Granted cannot be granted here.',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'PLUGIN_CONSENT_ACT_ANSWER: an answer does not match what is outstanding (rule and permissionSlugs say ' +
      'which). Also a body that fails validation, such as an empty answers list.',
  })
  @HttpCode(Http.Ok)
  @Post(':slug/consent/review')
  reviewConsent(@Param('slug') slug: string, @Body() dto: ReviewConsentDto) {
    return from(this.consentActs.review(this.actInput(slug, dto.manifestSha256, dto.answers))).pipe(
      map((result) =>
        consentActResponse(
          result.switchedOff
            ? t('success.plugin.consent_refused_switched_off', { slug })
            : t('success.plugin.consent_recorded', { slug }),
          result,
        ),
      ),
    );
  }

  @ApiOperation({
    summary: 'Disable your own unit for this plugin',
    description:
      'Flips your own switch off. Your consent decisions keep their records, and re-enabling restores exactly ' +
      'the state you left.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a session user (API keys cannot exercise this axis)' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed, or no enablement anchor exists' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @HttpCode(Http.Ok)
  @Post(':slug/disable')
  disable(@Param('slug') slug: string) {
    return from(this.units.disableUser({ slug, userId: this.selfUserId() })).pipe(
      map((unit) => ({ message: t('success.plugin.disabled', { slug }), unit })),
    );
  }

  @ApiOperation({
    summary: 'Per-feature activation state for your own unit (#60)',
    description:
      'Why a feature is or is not running for you: per-feature active|disabled with a denied|pending ' +
      'reason paired with the blocking permission slugs, plus the unit-level served, the unit state code, its ' +
      'dormancy and consent standing.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a session user (API keys cannot exercise this axis)' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  // Must stay out of the response cache: consent decisions must be visible on
  // the next read (#60).
  @Get(':slug/features')
  featureStates(@Param('slug') slug: string) {
    const unit: UserPluginUnit = { scopeType: 'User', userId: this.selfUserId() };

    return from(this.featureState.resolveForUnitBySlug(slug, unit, this.auditContext.getLocale() ?? undefined)).pipe(
      map((featureState) => ({ featureState })),
    );
  }

  /**
   * "The user themself", enforced: only a session-user actor may exercise
   * this axis. An API key resolves to its OWNER's id everywhere else — here
   * that would let a key of any scope consent on the owner's behalf, so the
   * kind check IS the missing ability floor (see the class doc).
   */
  private selfUserId(): string {
    return requireSessionUserId(this.auditContext.getActor());
  }

  /**
   * What every consent act of your own hands the service (#1150): you are
   * both the unit and the actor, and the locale is the one the consent
   * surface was shown in. The actor-kind check runs here, before the service
   * is asked.
   */
  private actInput(slug: string, manifestSha256: string, answers: readonly ConsentActAnswer[]): ConsentActInput {
    const userId = this.selfUserId();

    return {
      slug,
      unit: { scopeType: 'User', userId },
      actorId: userId,
      manifestSha256,
      answers,
      locale: this.auditContext.getLocale() ?? undefined,
    };
  }
}
