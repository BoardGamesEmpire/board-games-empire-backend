import type { HouseholdPluginUnit } from '@bge/actor-context';
import { AuditContextService } from '@bge/actor-context';
import { Action, DatabaseService, ResourceType } from '@bge/database';
import {
  alreadyTellsHouseholdsApart,
  householdExists,
  HouseholdLivenessGuard,
  HouseholdPathParam,
} from '@bge/household';
import { SupportedLocalesService, t } from '@bge/i18n';
import { AbilityService, CheckPolicies, PoliciesGuard, ScopeComposer } from '@bge/permissions';
import type { ConsentActAnswer, ConsentActInput } from '@bge/plugin';
import {
  PluginConsentActService,
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginInventoryService,
  PluginUnitLifecycleService,
} from '@bge/plugin';
import { DefaultPaginationQueryDto, paginated, PaginatedResponseDto } from '@bge/shared';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { consentActLocale } from './consent-act-locale';
import {
  consentActResponse,
  ConsentActResponseDto,
  ConsentSurfaceQueryDto,
  ConsentSurfaceResponseDto,
  PluginHouseholdInventoryEntryDto,
  ReviewConsentDto,
  SwitchOnHouseholdPluginDto,
  ToggleConsentDto,
  UpdatePluginConfigDto,
} from './dto';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';

const PaginatedHouseholdPluginsResponse = PaginatedResponseDto(PluginHouseholdInventoryEntryDto, 'plugins');

/**
 * Household-scope plugin consent (#59 Phase C4, #322): the household
 * admin's consent acts (#1150) and the consent surface they answer. #323
 * adds the unit enable/disable/config endpoints to this class. Nested under
 * the household per D-AX; plugins stay slug-addressed.
 *
 * Guard layering (D-AZ): the coarse CASL gate carries an INSTANCE check on
 * the route's household — the `manage:plugin:household` /
 * `read:plugin:household` seeds are conditioned on membership
 * (`{{ householdId }}` renders one rule per membership), so a type-level
 * `can()` would admit an admin of ANY household. The write path's authority
 * stays at the service seam (`PluginGrantAuthorityService` verifies
 * owner/admin of the anchoring household); the instance check is what keeps
 * the READ — which has no service seam — from serving one household's
 * decision states to another's admin. The instance check is
 * `AbilityService.assertCurrentActorCan`, which applies PoliciesGuard's
 * every-ability rule, so an API key's floor applies here too.
 *
 * Ahead of all of it, the household lib's liveness guard (#553): a missing or
 * soft-deleted household answers 404 on every route here, as on the household
 * routes (#299), for an actor every one of whose abilities reads `Household`.
 * Anyone else meets PoliciesGuard's 403 whatever the id. The guard's probe
 * takes no lock; the writes re-check under the household's share lock inside
 * their transactions (#548), and the exception filter answers that re-check's
 * refusal by the guard's rule, so losing the race tells no one more than the
 * guard would. The reads (the list, the consent surface and the feature
 * states) have no write to re-check in, so each checks liveness itself for an
 * actor the guard let through, after its instance check, and answers 403
 * (#790).
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@HouseholdPathParam('householdId')
@UseGuards(HouseholdLivenessGuard, PoliciesGuard)
@UseFilters(PluginExceptionFilter)
@ApiTags('household-plugins')
@Controller('households/:householdId/plugins')
export class HouseholdPluginsController {
  constructor(
    private readonly consentActs: PluginConsentActService,
    private readonly abilityService: AbilityService,
    private readonly presentation: PluginConsentPresentationService,
    private readonly units: PluginUnitLifecycleService,
    private readonly featureState: PluginFeatureStateService,
    private readonly inventory: PluginInventoryService,
    private readonly auditContext: AuditContextService,
    private readonly db: DatabaseService,
    private readonly scopeComposer: ScopeComposer,
    private readonly supportedLocales: SupportedLocalesService,
  ) {}

  // ─── Installed-plugin inventory for this household (#354) ─────────────────

  @ApiOperation({
    summary: 'List the plugins this household can enable, with its own enablement state',
    description:
      "Driven from the installed set, not from this household's enablement rows: every plugin the household axis " +
      'admits appears, with `unit.anchored` false where no row exists yet — so a household that has enabled ' +
      'nothing still sees what it could enable. A plugin whose scope no longer admits household enablement but ' +
      'for which this household still holds a unit enablement is listed too, with `unit.dormancy` unavailable — a ' +
      'retained unit enablement that serves nothing is exactly what a household admin needs to see. ' +
      "`unit.dormancy` says what stands in the way apart from the two switches, the unit's own and the Server " +
      'switch, whether or not the unit is switched on: unavailable means only a server admin can bring it back, ' +
      'needs_configuration that a conforming configuration would. A switched-on unit also reads unavailable ' +
      'while `serverEnabled` is false. Uninstalled plugins never ' +
      'appear — there is no path to participate in one again — and unlike `GET /plugins` this route accepts no ' +
      'flag to admit them.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, type: PaginatedHouseholdPluginsResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a member with read access to this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found, or deleted' })
  // The rows are plugins, so the read composes the caller's `Plugin` ceiling,
  // and an actor with no rule on `Plugin` is refused here rather than served
  // an empty page: an API key scoped to the household plugin routes alone,
  // say. Every user holds one through `read:plugin:installed`.
  @CheckPolicies(
    (ability) => ability.can(Action.read, ResourceType.HouseholdPlugin),
    (ability) => ability.can(Action.read, ResourceType.Plugin),
  )
  // Must stay out of the response cache: the writes on this controller change
  // these rows, and must be visible on the re-read.
  @Get()
  list(@Param('householdId') householdId: string, @Query() query: DefaultPaginationQueryDto) {
    // The instance half of the D-AZ gate. This read has no service seam to
    // re-verify authority, so without it a type-level `can()` would serve one
    // household's enablement states to another household's admin.
    this.abilityService.assertCurrentActorCan(Action.read, ResourceType.HouseholdPlugin, { householdId });

    return from(this.listInventory(householdId, query)).pipe(
      map((page) => paginated('plugins', page, query, ResourceType.Plugin)),
    );
  }

  @ApiOperation({
    summary: "Present the consent surface for this household: the active manifest's, or a staged update's",
    description:
      "The household's consent surface: every requested permission, with this household's " +
      "decision state per permission — server-consented ones show the server's concrete state (one addressable " +
      "decider), user-consented ones read 'per-unit' (every user decides for themself) — plus riskLevel, " +
      'required, grantable, localized reason, and the localized features[] they group under. manifestSha256 names ' +
      'the plugin artifact presented, and stagedUpdate names an update waiting for the server admin. With ' +
      'manifest=staged it presents that update instead, so the household can pre-consent; stagedOnly then marks ' +
      'what the active manifest does not request.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, type: ConsentSurfaceResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a member with read access to this household' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'Household not found or deleted, plugin not installed, or (manifest=staged) no update waiting',
  })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.HouseholdPlugin))
  // Must stay out of the response cache: read right before a consent act,
  // whose writes must be visible on the re-read (#1150).
  @Get(':slug/consent')
  consentPresentation(
    @Param('householdId') householdId: string,
    @Param('slug') slug: string,
    @Query() query: ConsentSurfaceQueryDto = {},
  ) {
    this.abilityService.assertCurrentActorCan(Action.read, ResourceType.HouseholdPlugin, { householdId });

    const unit: HouseholdPluginUnit = { scopeType: 'Household', householdId };
    const locale = this.auditContext.getLocale() ?? undefined;

    return from(
      this.assertLiveForUnguardedActor(householdId).then(() =>
        // The staged consent surface lets the household pre-consent (#1150).
        query.manifest === 'staged'
          ? this.presentation.presentStagedForUnitBySlug(slug, unit, locale)
          : this.presentation.presentForUnitBySlug(slug, unit, locale),
      ),
    ).pipe(map((presentation) => ({ presentation })));
  }

  // ─── Consent acts (#1150) and unit enablement (#323) ──────────────────────
  // Switching on, toggling and reviewing are each one recorded consent act.
  // Each answers 200 whether or not it changed anything (changed: false and
  // act: null when it did not), so repeating one is safe.

  @ApiOperation({
    summary: 'Switch the plugin on for this household, answering its requested permissions',
    description:
      'One consent act: the household admin answers the requested permissions this household decides, as the ' +
      "active manifest's consent surface (GET …/consent) showed them, and the plugin is switched on here. A " +
      'switch-on names the active manifest only; to pre-consent to a staged update, send a review ' +
      '(POST …/consent/review) against the manifest=staged consent surface. Every required permission must be Granted; optional ones may be ' +
      'answered either way or left for later. manifestSha256 names the consent surface the answers were read ' +
      "from. Optional config is validated against the manifest's config.schema and written with the switch-on. " +
      'Without config, the configuration the unit would hold (its retained one, or an empty one for a first ' +
      "switch-on) must fit the manifest's config.schema, with or without requiresHouseholdConfig. Switching on " +
      'again without config, when nothing would change, answers changed: false; a unit already on whose ' +
      'retained configuration no longer fits the plugin is answered 409 with the violations instead. A ' +
      'switch-on that sends config always records a consent act and writes the config.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, type: ConsentActResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'You are not an owner or admin of this household' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'The household does not exist or was deleted, or the plugin is not installed',
  })
  @ApiResponse({ status: Http.Gone, description: 'The plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'PLUGIN_CONSENT_ACT_STALE: the plugin or a permission risk changed since the consent surface was read; ' +
      'read it again and answer again. PLUGIN_CONSENT_ACT_UNGRANTABLE: a required permission cannot be granted ' +
      'here, which only a server admin can fix. PLUGIN_UNIT_CONFIG_REQUIRED: no config was sent, and the ' +
      "configuration the unit would hold (its retained one, or an empty one) does not fit the manifest's " +
      'config.schema, or this is a first switch-on of a plugin that sets requiresHouseholdConfig ' +
      '(issues[] names what to fix, and is empty in that last case).',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'PLUGIN_CONSENT_ACT_REQUIRED_SET: a required permission was left out (missingSlugs) or Denied ' +
      '(refusedSlugs). PLUGIN_CONSENT_ACT_ANSWER: an answer does not match what the plugin asks for (rule and ' +
      "permissionSlugs say which). PLUGIN_CONFIG_VALIDATION: config does not match the plugin's schema. " +
      'PLUGIN_UNIT_SCOPE: the plugin cannot be switched on per household. PLUGIN_CONSENT_ACT_LOCALE: locale is ' +
      'not one this server supports. Also a body that fails validation.',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @HttpCode(Http.Ok)
  @Post(':slug/enable')
  enable(
    @Param('householdId') householdId: string,
    @Param('slug') slug: string,
    @Body() dto: SwitchOnHouseholdPluginDto,
  ) {
    this.abilityService.assertCurrentActorCan(Action.manage, ResourceType.HouseholdPlugin, { householdId });

    return from(
      this.consentActs.switchOn({
        ...this.actInput(householdId, slug, dto, dto.answers),
        config: dto.config,
      }),
    ).pipe(map((result) => consentActResponse(t('success.plugin.enabled', { slug }), result)));
  }

  @ApiOperation({
    summary: 'Grant or refuse one optional requested permission for this household',
    description:
      'One consent act that changes the answer to one optional requested permission while the plugin is ' +
      'switched on here. A required permission cannot be toggled: refusing one means switching the plugin off, ' +
      'or answering it in a review. Repeating the current answer answers changed: false.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, type: ConsentActResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'You are not an owner or admin of this household' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'The household does not exist or was deleted, or the plugin is not installed',
  })
  @ApiResponse({ status: Http.Gone, description: 'The plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'PLUGIN_CONSENT_ACT_UNIT_OFF: the plugin is switched off for this household; switch it on first. ' +
      'PLUGIN_CONSENT_ACT_STALE: the plugin or the permission risk changed since the consent surface was read. ' +
      'PLUGIN_CONSENT_ACT_UNGRANTABLE: the permission cannot be granted here.',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'PLUGIN_CONSENT_ACT_ANSWER: the permission is not requested, is required, or is not decided by this ' +
      'household (rule says which). PLUGIN_CONSENT_ACT_LOCALE: locale is not one this server supports. Also a ' +
      'body that fails validation.',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @HttpCode(Http.Ok)
  @Post(':slug/consent/toggle')
  toggleConsent(@Param('householdId') householdId: string, @Param('slug') slug: string, @Body() dto: ToggleConsentDto) {
    this.abilityService.assertCurrentActorCan(Action.manage, ResourceType.HouseholdPlugin, { householdId });

    return from(this.consentActs.toggle(this.actInput(householdId, slug, dto, [dto.answer]))).pipe(
      map((result) => consentActResponse(t('success.plugin.consent_recorded', { slug }), result)),
    );
  }

  @ApiOperation({
    summary: 'Answer what the plugin, or its staged update, still asks this household',
    description:
      'One consent act that answers the requested permissions the active manifest leaves outstanding, or, ' +
      'with the sha of a staged update, those the update adds (pre-consent). Refusing a required permission ' +
      'switches the plugin off for this household in the same consent act, and the response says so ' +
      '(switchedOff: true). Sending that review again changes nothing and answers the same way.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Ok, type: ConsentActResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'You are not an owner or admin of this household' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'The household does not exist or was deleted, or the plugin is not installed',
  })
  @ApiResponse({ status: Http.Gone, description: 'The plugin was uninstalled' })
  @ApiResponse({
    status: Http.Conflict,
    description:
      'PLUGIN_CONSENT_ACT_UNIT_OFF: the plugin is switched off for this household. PLUGIN_CONSENT_ACT_STALE: ' +
      'the plugin, its staged update or a permission risk changed since the consent surface was read. ' +
      'PLUGIN_CONSENT_ACT_UNGRANTABLE: a permission answered Granted cannot be granted here.',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'PLUGIN_CONSENT_ACT_ANSWER: an answer does not match what is outstanding (rule and permissionSlugs say ' +
      'which). PLUGIN_CONSENT_ACT_LOCALE: locale is not one this server supports. Also a body that fails ' +
      'validation, such as an empty answers list.',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @HttpCode(Http.Ok)
  @Post(':slug/consent/review')
  reviewConsent(@Param('householdId') householdId: string, @Param('slug') slug: string, @Body() dto: ReviewConsentDto) {
    this.abilityService.assertCurrentActorCan(Action.manage, ResourceType.HouseholdPlugin, { householdId });

    return from(this.consentActs.review(this.actInput(householdId, slug, dto, dto.answers))).pipe(
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
    summary: 'Disable the plugin for this household',
    description:
      "Flips the household's own switch off. Consent standing is untouched: a durable denial keeps its " +
      'record, and re-enabling restores exactly the consent standing the unit had. Unlike enable and the config ' +
      'write, this route accepts a unit enablement whose plugin scope no longer admits household enablement ' +
      '(state unavailable): it is listed for this household, and switching it off is the only action left that ' +
      'makes sense. After it the unit reads state off, and its dormancy stays unavailable: dormancy is not the ' +
      "switch, and lifting it is an activation's business.",
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner/admin of this household' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'Household not found or deleted, plugin not installed, or never enabled for this household',
  })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @HttpCode(Http.Ok)
  @Post(':slug/disable')
  disable(@Param('householdId') householdId: string, @Param('slug') slug: string) {
    this.abilityService.assertCurrentActorCan(Action.manage, ResourceType.HouseholdPlugin, { householdId });

    return from(
      this.units.disableHousehold({ slug, householdId, actorId: this.abilityService.getActingUserId() }),
    ).pipe(map((unit) => ({ message: t('success.plugin.disabled', { slug }), unit })));
  }

  @ApiOperation({
    summary: "Replace this household's plugin configuration",
    description:
      "Validates the payload against the manifest's config.schema (422 with issues[] on violation) and persists " +
      'it. Last-writer-wins; there is no optimistic locking. Validation against the ACTIVE schema is also what ' +
      'heals config left stale by an update or reinstall.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner/admin of this household' })
  @ApiResponse({
    status: Http.NotFound,
    description: 'Household not found or deleted, plugin not installed, or never enabled for this household',
  })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description:
      'Configuration violates the declared schema (issues[] names the violations), or the plugin is server-scoped ' +
      'and has no household config surface (no issues[])',
  })
  @ApiResponse({
    status: Http.Conflict,
    description:
      "The plugin's active manifest was replaced mid-request — an activation or a reinstall, not necessarily at a " +
      'new version — so the document was judged against the old schema',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @Patch(':slug/config')
  updateConfig(
    @Param('householdId') householdId: string,
    @Param('slug') slug: string,
    @Body() dto: UpdatePluginConfigDto,
  ) {
    this.abilityService.assertCurrentActorCan(Action.manage, ResourceType.HouseholdPlugin, { householdId });

    return from(
      this.units.updateHouseholdConfig({
        slug,
        householdId,
        actorId: this.abilityService.getActingUserId(),
        config: dto.config,
      }),
    ).pipe(map((unit) => ({ message: t('success.plugin.config_updated', { slug }), unit })));
  }

  @ApiOperation({
    summary: "Per-feature activation state for this household's unit (#60)",
    description:
      'Why a feature is or is not running here: per-feature active|disabled with a denied|pending ' +
      'reason paired with the blocking permission slugs (the client renders actionable "why is this missing" ' +
      'feedback from the pairing), plus the unit-level served, the unit state code, its dormancy (what stands in ' +
      "the way apart from the two switches, the unit's own and the Server switch, whether or not the unit is " +
      'switched on) and consent standing.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a member with read access to this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Household not found or deleted, or plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'The plugin is server-scoped: this household has no enablement surface to report on',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.HouseholdPlugin))
  // Must stay out of the response cache: consent decisions must be visible on
  // the next read (#60).
  @Get(':slug/features')
  featureStates(@Param('householdId') householdId: string, @Param('slug') slug: string) {
    this.abilityService.assertCurrentActorCan(Action.read, ResourceType.HouseholdPlugin, { householdId });

    const unit: HouseholdPluginUnit = { scopeType: 'Household', householdId };

    return from(
      this.assertLiveForUnguardedActor(householdId).then(() =>
        this.featureState.resolveForUnitBySlug(slug, unit, this.auditContext.getLocale() ?? undefined),
      ),
    ).pipe(map((featureState) => ({ featureState })));
  }

  /**
   * Refuses a deleted household to an actor the liveness guard let through.
   *
   * The guard answers liveness only for an actor every one of whose abilities
   * reads households, and lets anyone else through untouched, such as a staff
   * member's API key scoped to the plugin routes. Its owner reads every
   * household's plugins, and a soft delete leaves them in place, so without a
   * check here the key would read a deleted household's plugins, its consent
   * decisions and its feature states (#790). The reads check for that actor
   * alone, so one the guard answered is not probed twice. Each runs it after
   * its instance check, so only an actor who may read the route is answered
   * at all.
   *
   * The answer is the instance check's 403, the one these routes give any
   * actor they refuse: a 404 would tell a key scoped away from households which
   * household was deleted, or that an id never existed. The writes answer by
   * the same rule (`PluginExceptionFilter.asTheActorSeesIt`).
   */
  private async assertLiveForUnguardedActor(householdId: string): Promise<void> {
    if (
      !alreadyTellsHouseholdsApart(this.abilityService.getCurrentAbilities()) &&
      !(await householdExists(this.db, householdId))
    ) {
      throw new ForbiddenException(t('common.forbidden.action'));
    }
  }

  /**
   * What every household consent act hands the service (#1150): the route
   * household as the unit, the acting user, and the locale the consent
   * surface was shown in: the one the body names, refused unless this server
   * supports it, else the request's own, as the consent read resolves it
   * (#1301). The service verifies the actor's authority again before its
   * transaction; inside it, only the household's liveness is locked.
   */
  private actInput(
    householdId: string,
    slug: string,
    body: { readonly locale?: string; readonly manifestSha256: string },
    answers: readonly ConsentActAnswer[],
  ): ConsentActInput {
    return {
      slug,
      unit: { scopeType: 'Household', householdId },
      actorId: this.abilityService.getActingUserId(),
      manifestSha256: body.manifestSha256,
      answers,
      locale: consentActLocale(
        body.locale,
        this.supportedLocales.getSupportedTags(),
        this.auditContext.getLocale() ?? undefined,
      ),
    };
  }

  /** The household's plugins, once it is known to be live. */
  private async listInventory(householdId: string, query: DefaultPaginationQueryDto) {
    await this.assertLiveForUnguardedActor(householdId);

    return this.inventory.listForHousehold(
      householdId,
      query,
      (scope) => this.scopeComposer.compose(ResourceType.Plugin, Action.read, scope),
      { locale: this.auditContext.getLocale() ?? undefined },
    );
  }
}
