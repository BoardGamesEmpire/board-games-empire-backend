import { AuditContextService, isUserActor, type UserPluginUnit } from '@bge/actor-context';
import { PluginGrantScope } from '@bge/database';
import { t } from '@bge/i18n';
import {
  PluginConsentPresentationService,
  PluginFeatureStateService,
  PluginGrantService,
  PluginInventoryService,
  PluginUnitLifecycleService,
} from '@bge/plugin';
import { DefaultPaginationQueryDto, NoCache, paginated, PaginatedResponseDto } from '@bge/shared';
import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { DecidePluginGrantDto, PluginUnitInventoryEntryDto } from './dto';
import { PluginExceptionFilter } from './filters/plugin-exception.filter';

const PaginatedUserPluginsResponse = PaginatedResponseDto(PluginUnitInventoryEntryDto, 'plugins');

/**
 * User-scope plugin consent (#59 Phase C4, #322): each user's own grant
 * decisions and the consent surface they decide from. #323 adds the unit
 * enable/disable endpoints to this class. Self-addressed under `/users/me`
 * per D-AX — the acting user from CLS is BOTH the decider and the consent
 * unit, so no one else's unit is addressable, and no permission seed exists
 * for this axis (D-BA seeded only the server and household pairs).
 *
 * With no seed, PoliciesGuard has nothing to clamp an API key's floor on —
 * so the gate here is the actor KIND: user-scope consent is "decided by the
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
    private readonly grants: PluginGrantService,
    private readonly presentation: PluginConsentPresentationService,
    private readonly units: PluginUnitLifecycleService,
    private readonly featureState: PluginFeatureStateService,
    private readonly inventory: PluginInventoryService,
    private readonly auditContext: AuditContextService,
  ) {}

  // ─── Installed-plugin inventory for the acting user (#354) ────────────────

  @ApiOperation({
    summary: 'List the plugins you can enable, with your own enablement state',
    description:
      'Every installed plugin, narrowed by no scope at all: user-scope consent is legal at any plugin scope ' +
      '(#225), so unlike the household axis there is no plugin you cannot be anchored on. `unit.anchored` is ' +
      'false until your first Granted decision creates the anchor — which is why an empty enablement history ' +
      'shows a populated list of not-yet-enabled plugins rather than nothing. Carries no version, provenance or ' +
      'install history, and never tombstones: this surface exists to decide your own participation, not to ' +
      'inspect the server.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedUserPluginsResponse })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'API keys cannot read a user consent surface' })
  // Localized body; the response cache keys without the resolved locale (#358).
  @NoCache()
  @Get()
  list(@Query() query: DefaultPaginationQueryDto) {
    return from(
      this.inventory.listForUser(this.selfUserId(), query, {
        locale: this.auditContext.getLocale() ?? undefined,
      }),
    ).pipe(map((page) => paginated('plugins', page, query)));
  }

  @ApiOperation({
    summary: 'Record an own-user consent decision for one requested permission',
    description:
      'Grant or durably deny a permission the active manifest requests at user consent scope, for your own ' +
      'account. A Granted decision creates your enablement anchor (#225); a Denied decision creates nothing — ' +
      'and a denial that leaves a REQUIRED user check unsatisfied suspends your unit until late acceptance.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'A categorically ungrantable permission' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @ApiResponse({
    status: Http.UnprocessableEntity,
    description: 'Not requested by the manifest, or decided at the wrong consent scope',
  })
  @HttpCode(Http.Ok)
  @Post(':slug/grants')
  decideGrant(@Param('slug') slug: string, @Body() dto: DecidePluginGrantDto) {
    const userId = this.selfUserId();

    return from(
      this.grants.decide({
        slug,
        scopeType: PluginGrantScope.User,
        scopeId: userId,
        permissionSlug: dto.permissionSlug,
        status: dto.status,
        deciderId: userId,
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
    summary: "Present the active manifest's consent surface for your own unit",
    description:
      'Your consent screen: every check the active manifest requests, with your own decision state per check — ' +
      "server-consented checks show the server's concrete state (one addressable decider), household-consented " +
      "checks read 'per-unit' (every household decides for itself) — plus riskLevel, required, localized reason, " +
      'and the localized features[] the checks group under.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  // Mutation-adjacent (read right before a decide POST, which must be
  // visible on the re-read) — and the response cache keys without the
  // resolved locale (#358), which would cross-serve localized bodies.
  @NoCache()
  @Get(':slug/consent')
  consentPresentation(@Param('slug') slug: string) {
    const unit: UserPluginUnit = { scopeType: 'User', userId: this.selfUserId() };

    return from(this.presentation.presentForUnitBySlug(slug, unit, this.auditContext.getLocale() ?? undefined)).pipe(
      map((presentation) => ({ presentation })),
    );
  }

  // ─── Unit enablement (#323): the user's own switch ─────────────────────────

  @ApiOperation({
    summary: 'Enable your own unit for this plugin',
    description:
      'Flips your own switch (enabled) back on. The enablement row is created by your first Granted user-scope ' +
      'consent decision (#225) — without one there is nothing to enable (404). Consent suspension is separate ' +
      'state this endpoint never writes: a suspended unit stays suspended until late acceptance clears it.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a session user (API keys cannot exercise this axis)' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed, or no enablement anchor exists' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  @HttpCode(Http.Ok)
  @Post(':slug/enable')
  enable(@Param('slug') slug: string) {
    return from(this.units.enableUser({ slug, userId: this.selfUserId() })).pipe(
      map((unit) => ({ message: t('success.plugin.enabled', { slug }), unit })),
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
      'Why a feature is or is not running for you: per-feature active|disabled with a denied|pending|suspended ' +
      'reason paired with the blocking permission slugs, plus the unit-level served and suspendedForConsent state.',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Not a session user (API keys cannot exercise this axis)' })
  @ApiResponse({ status: Http.NotFound, description: 'Plugin not installed' })
  @ApiResponse({ status: Http.Gone, description: 'Plugin was uninstalled (tombstoned)' })
  // Consent decisions must be visible on the next read (#60 keeps this
  // surface uncached) — and the response cache keys without the resolved
  // locale (#358), which would cross-serve localized bodies.
  @NoCache()
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
    const actor = this.auditContext.getActor();

    if (!actor || !isUserActor(actor)) {
      throw new ForbiddenException(t('common.forbidden.action'));
    }

    return actor.userId;
  }
}
