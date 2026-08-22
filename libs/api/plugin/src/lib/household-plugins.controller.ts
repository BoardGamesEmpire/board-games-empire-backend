import { AuditContextService, type HouseholdPluginUnit } from '@bge/actor-context';
import { Action, PluginGrantScope, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import {
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginGrantService,
  PluginUnitLifecycleService,
} from '@bge/plugin';
import { NoCache } from '@bge/shared';
import { subject } from '@casl/ability';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { DecidePluginGrantDto, EnableHouseholdPluginDto, UpdatePluginConfigDto } from './dto';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';

/**
 * Household-scope plugin consent (#59 Phase C4, #322): the household
 * admin's grant decisions and the consent surface they decide from. #323
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
 * decision states to another's admin. Mirrors PoliciesGuard's
 * every-ability semantics so an API key's floor applies here too.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@UseFilters(PluginExceptionFilter)
@ApiTags('household-plugins')
@Controller('households/:householdId/plugins')
export class HouseholdPluginsController {
  constructor(
    private readonly grants: PluginGrantService,
    private readonly abilityService: AbilityService,
    private readonly presentation: PluginConsentPresentationService,
    private readonly units: PluginUnitLifecycleService,
    private readonly featureState: PluginFeatureStateService,
    private readonly auditContext: AuditContextService,
  ) {}

  @ApiOperation({
    summary: 'Record a household-scope consent decision for one requested permission',
    description:
      'Grant or durably deny a permission the active manifest requests at household consent scope, for this ' +
      'household. Idempotent on exact re-statement (changed: false). A denial that leaves a REQUIRED household ' +
      "check unsatisfied suspends the household's unit (suspendedForConsent) — late acceptance re-enables it.",
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Not an owner/admin of this household, or a categorically ungrantable permission',
  })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'Not requested by the manifest, or decided at the wrong consent scope',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @HttpCode(Http.Ok)
  @Post(':slug/grants')
  decideGrant(
    @Param('householdId') householdId: string,
    @Param('slug') slug: string,
    @Body() dto: DecidePluginGrantDto,
  ) {
    this.assertHouseholdScope(Action.manage, householdId);

    return from(
      this.grants.decide({
        slug,
        scopeType: PluginGrantScope.Household,
        scopeId: householdId,
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
    summary: "Present the active manifest's consent surface for this household",
    description:
      "The household admin's consent screen: every check the active manifest requests, with this household's " +
      "decision state per check — server-consented checks show the server's concrete state (one addressable " +
      "decider), user-consented checks read 'per-unit' (every user decides for themself) — plus riskLevel, " +
      'required, localized reason, and the localized features[] the checks group under.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a member with read access to this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.HouseholdPlugin))
  // Mutation-adjacent (read right before a decide POST, which must be
  // visible on the re-read) — and the response cache keys without the
  // resolved locale (#358), which would cross-serve localized bodies.
  @NoCache()
  @Get(':slug/consent')
  consentPresentation(@Param('householdId') householdId: string, @Param('slug') slug: string) {
    this.assertHouseholdScope(Action.read, householdId);

    const unit: HouseholdPluginUnit = { scopeType: 'Household', householdId };

    return from(this.presentation.presentForUnitBySlug(slug, unit, this.auditContext.getLocale() ?? undefined)).pipe(
      map((presentation) => ({ presentation })),
    );
  }

  // ─── Unit enablement (#323): the admin's switch and config ────────────────

  @ApiOperation({
    summary: 'Enable the plugin for this household',
    description:
      "The household admin's own switch (enabled), layered under the server-level one — consent suspension is " +
      'separate state this endpoint never writes, so a consent-suspended unit stays suspended across an enable. ' +
      'First enable creates the enablement row; optional config is validated against the manifest config.schema ' +
      'and written atomically with it. When the manifest requires household config, enabling without config ' +
      'demands a valid retained document (409 with the violations otherwise). A row created while a required ' +
      'household permission carries a durable denial is born consent-suspended and heals through late acceptance.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner/admin of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({
    status: Http.Conflict,
    description: 'Required household config neither supplied nor validly retained (issues[] names violations)',
  })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'Supplied config violates the declared schema, or the plugin is server-scoped',
  })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @HttpCode(Http.Ok)
  @Post(':slug/enable')
  enable(
    @Param('householdId') householdId: string,
    @Param('slug') slug: string,
    @Body() dto: EnableHouseholdPluginDto,
  ) {
    this.assertHouseholdScope(Action.manage, householdId);

    return from(
      this.units.enableHousehold({
        slug,
        householdId,
        actorId: this.abilityService.getActingUserId(),
        config: dto.config,
      }),
    ).pipe(map((unit) => ({ message: t('success.plugin.enabled', { slug }), unit })));
  }

  @ApiOperation({
    summary: 'Disable the plugin for this household',
    description:
      "Flips the household's own switch off. Consent state is untouched: a durable denial or suspension keeps " +
      'its record, and re-enabling restores exactly the consent state the unit had.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not an owner/admin of this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed, or never enabled for this household' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @HttpCode(Http.Ok)
  @Post(':slug/disable')
  disable(@Param('householdId') householdId: string, @Param('slug') slug: string) {
    this.assertHouseholdScope(Action.manage, householdId);

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
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed, or never enabled for this household' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({ status: Http.UnprocessableEntity, description: 'Configuration violates the declared schema' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.HouseholdPlugin))
  @Patch(':slug/config')
  updateConfig(
    @Param('householdId') householdId: string,
    @Param('slug') slug: string,
    @Body() dto: UpdatePluginConfigDto,
  ) {
    this.assertHouseholdScope(Action.manage, householdId);

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
      'Why a feature is or is not running here: per-feature active|disabled with a denied|pending|suspended ' +
      'reason paired with the blocking permission slugs (the client renders actionable "why is this missing" ' +
      'feedback from the pairing), plus the unit-level served and suspendedForConsent state.',
  })
  @ApiParam({ name: 'householdId', type: String })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a member with read access to this household' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'The plugin is server-scoped: this household has no enablement surface to report on',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.HouseholdPlugin))
  // Consent decisions must be visible on the next read (#60 keeps this
  // surface uncached) — and the response cache keys without the resolved
  // locale (#358), which would cross-serve localized bodies.
  @NoCache()
  @Get(':slug/features')
  featureStates(@Param('householdId') householdId: string, @Param('slug') slug: string) {
    this.assertHouseholdScope(Action.read, householdId);

    const unit: HouseholdPluginUnit = { scopeType: 'Household', householdId };

    return from(this.featureState.resolveForUnitBySlug(slug, unit, this.auditContext.getLocale() ?? undefined)).pipe(
      map((featureState) => ({ featureState })),
    );
  }

  /**
   * The instance half of the household gate: every current ability must
   * allow the action on THIS household's `HouseholdPlugin` rows — the same
   * AND-across-abilities rule PoliciesGuard applies to the type-level
   * check, so an API key's floor clamps here identically. The empty-array
   * deny is also PoliciesGuard's: `[].every(...)` is vacuously true, and an
   * actor kind that primes no abilities must not pass an authorization gate
   * by having nothing to check. Today the routes' own @CheckPolicies makes
   * the guard throw on that case first; this keeps the mirror honest when
   * #323 adds routes to this class.
   */
  private assertHouseholdScope(action: Action, householdId: string): void {
    const abilities = this.abilityService.getCurrentAbilities();
    const allowed =
      abilities.length > 0 &&
      abilities.every((ability) => ability.can(action, subject(ResourceType.HouseholdPlugin, { householdId })));

    if (!allowed) {
      throw new ForbiddenException(t('common.forbidden.action'));
    }
  }
}
