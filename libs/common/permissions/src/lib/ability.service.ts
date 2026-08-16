import {
  type Actor,
  AuditContextService,
  isApiKeyActor,
  isPluginActor,
  isSystemActor,
  isUserActor,
  type PluginActor,
} from '@bge/actor-context';
import { Action } from '@bge/database';
import { t } from '@bge/i18n';
import { accessibleBy, type WhereInput } from '@casl/prisma';
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AbilityFactory } from './ability.factory';
import { AbilityContextNotPrimedError } from './errors/ability-context-not-primed.error';
import { PluginAbilityRenderRejectionError } from './errors/plugin-ability-render-rejection.error';
import type { AppAbility, ModelResourceType } from './interfaces';
import { PermissionsService } from './permissions.service';
import { AbilityContextInternalService } from './services/ability-context-internal.service';

/**
 * Central ability-resolution surface for every actor kind.
 *
 * Resolution model (issue #68):
 * - `user`     → `[userAbility]`
 * - `apiKey`   → `[ownerUserAbility, apiKeyAbility]` (intersected via AND at
 *                query time — effective access is the *floor* of the two, so an
 *                over-scoped key or a user-level restriction both clamp access
 *                down)
 * - `system`   → `[systemAbility]` (`manage all`; `reason` is audit-only for now)
 * - `plugin`   → `[pluginAbility]` (#60): the granted set for the actor's
 *                operating consent unit, single-element by design — never
 *                intersected with the triggering user (#60). A unit that is
 *                not currently served resolves to a no-rule ability (denies
 *                everything); a grant that cannot be rendered safely is a
 *                typed rejection surfaced as 403.
 * - `anonymous`/`external` → resolution throws (see
 *   {@link resolveAbilitiesForActor}); these are deferred / have no query surface.
 *
 * Plugins are installed principals, not delegations of user authority — the
 * "no intersection with the triggering user" rule is enforced by what populates
 * the array (a single-element `[pluginAbility]`), not by special-casing
 * intersection logic here.
 */
@Injectable()
export class AbilityService {
  private readonly logger = new Logger(AbilityService.name);

  constructor(
    private readonly auditContext: AuditContextService,
    private readonly abilityContext: AbilityContextInternalService,
    private readonly permissionsService: PermissionsService,
    private readonly abilityFactory: AbilityFactory,
  ) {}

  getActingUserId(): string {
    return this.auditContext.getActingUserId();
  }

  /**
   * The current actor's resolved ability array, primed once per request by
   * `AbilityContextMiddleware`. Synchronous by design — the single async
   * resolution happens at the transport boundary (Option A).
   *
   * Throws when nothing has been primed for the current context, i.e. there is
   * no actor for this request or no populator ran. This is a programmer error
   * (a 500), distinct from an authorization failure: for explicit-actor
   * scenarios (tests, event listeners, replay) call
   * {@link resolveAbilitiesForActor} instead, or wrap the work in `cls.run()`
   * with a primed context.
   */
  getCurrentAbilities(): AppAbility[] {
    const abilities = this.abilityContext.peek();

    if (!abilities) {
      throw new AbilityContextNotPrimedError();
    }

    return abilities;
  }

  /**
   * Builds the CASL where-AND clause for the current actor over a resource type
   * and action. This is the 99% service-layer authorization-filtering case.
   *
   * `action` is required and never defaulted: defaulting to `read` (the CASL
   * convenience) silently mis-authorizes mutation paths.
   */
  getCurrentResourceConditions<TResource extends ModelResourceType>(
    resourceType: TResource,
    action: Action,
  ): WhereInput<TResource>[] {
    return this.getResourceConditionsForAbilities(this.getCurrentAbilities(), resourceType, action);
  }

  /**
   * Explicit-abilities → conditions. Used by tests, cross-actor reasoning
   * ("what would actor X see"), and replay/audit scenarios. Produces output
   * identical to {@link getCurrentResourceConditions} for the same actor.
   *
   * Throws `ForbiddenException` when no conditions are produced — which can only
   * happen when `abilities` is empty. `accessibleBy(...).ofType(...)` always
   * yields a clause for a non-empty ability (a permissive `{}`, a conditional
   * `{ OR: [...] }`, or a deny-all `{ OR: [] }`), so a non-empty array never
   * collapses to `AND: []`. Guarding the empty case is what prevents the
   * unfiltered-query regression by construction.
   */
  getResourceConditionsForAbilities<TResource extends ModelResourceType>(
    abilities: AppAbility[],
    resourceType: TResource,
    action: Action,
  ): WhereInput<TResource>[] {
    if (abilities.length === 0) {
      throw new ForbiddenException(t('common.forbidden.access'));
    }

    try {
      return abilities.map((ability) => accessibleBy(ability, action).ofType(resourceType));
    } catch (error) {
      this.logger.error(
        `Failed to build '${action}' conditions for ${resourceType}; treating as denied.`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new ForbiddenException(t('common.forbidden.access'));
    }
  }

  /**
   * Resolves and primes the current actor's abilities into CLS. The single
   * public priming entry point — every transport populator (HTTP middleware,
   * BullMQ worker host, …) calls this once the actor is in CLS.
   *
   * Primes only the *current* actor (read from CLS); there is no arbitrary-actor
   * parameter, so this cannot forge an ability set. Unauthenticated and
   * not-yet-supported kinds (`anonymous`/`external`) prime `[]`, which the
   * query layer and PoliciesGuard treat as denial — never an unfiltered
   * query. Resolution failures (revoked key, DB error) propagate to the caller
   * (→ request/job failure) rather than degrading silently.
   */
  async primeCurrentActor(): Promise<void> {
    const actor = this.auditContext.getActor();
    const abilities = actor && isResolvableActor(actor) ? await this.resolveAbilitiesForActor(actor) : [];

    this.abilityContext.prime(abilities);
    this.logger.debug(`Primed ${abilities.length} ability set(s) for actor '${actor?.kind ?? 'none'}'`);
  }

  /**
   * Resolves the ability array for an explicit actor. Called by the priming
   * middleware at request start, and usable directly by tests and listeners
   * reconstructing ability for an actor referenced in an event payload.
   *
   * Async because resolution is DB-backed (role graph / api-key scope graph).
   * Throws for actor kinds with no implemented ability surface rather than
   * returning `[]` — an empty array must never originate here, since a silent
   * `[]` is the `AND: []` footgun this service exists to prevent.
   */
  async resolveAbilitiesForActor(actor: Actor): Promise<AppAbility[]> {
    switch (actor.kind) {
      case 'user':
        return [await this.buildUserAbility(actor.userId)];

      case 'apiKey':
        return [await this.buildUserAbility(actor.userId), await this.buildApiKeyAbility(actor.apiKeyId)];

      case 'system':
        return [this.abilityFactory.createForSystem(actor.reason)];

      case 'anonymous':
        throw new Error(
          'Anonymous actor abilities are not implemented yet. The anonymous ' +
            'permission set is deferred to a later slice (issue #68 follow-up).',
        );

      case 'external':
        throw new Error(
          'External actors have no ability surface; they are audit-only and ' +
            'cannot perform ability-filtered queries.',
        );

      case 'plugin':
        return [await this.buildPluginAbility(actor)];

      default:
        return assertNeverActor(actor);
    }
  }

  /**
   * The underlying user ability when the current actor delegates from a user —
   * API keys only. Returns `null` for every other kind, including `user`/
   * `anonymous` (they are the principal, not a delegation) and `system`/
   * `external`/`plugin` (no delegated user authority).
   *
   * Reads the primed context directly (not {@link getCurrentAbilities}) so an
   * unprimed context returns `null` rather than throwing — this accessor's
   * contract is "the owner ability or nothing", never a 500.
   */
  getTriggeringUserAbility(): AppAbility | null {
    const actor = this.auditContext.getActor();
    if (!actor || !isApiKeyActor(actor)) {
      return null;
    }

    const [ownerAbility] = this.abilityContext.peek() ?? [];
    return ownerAbility ?? null;
  }

  private async buildUserAbility(userId: string): Promise<AppAbility> {
    const graph = await this.permissionsService.getUserRoleGraph(userId);
    return this.abilityFactory.createForUser(graph);
  }

  private async buildApiKeyAbility(apiKeyId: string): Promise<AppAbility> {
    const apiKey = await this.permissionsService.getApiKeyScopeGraph(apiKeyId);

    if (!apiKey) {
      this.logger.warn(`API key ${apiKeyId} resolved an actor but could not be loaded for ability resolution`);
      throw new ForbiddenException(t('errors.api_key.not_found_or_revoked'));
    }

    return this.abilityFactory.createForApiKey(apiKey);
  }

  /**
   * Builds the single-element plugin ability (#60). Two failure shapes,
   * deliberately distinct:
   *
   * - **Quiet denial** — no `Plugin` row (dangling actor), or the unit fails
   *   the serving predicate: a no-rule ability that denies everything. Not
   *   an error; the unit simply is not being served.
   * - **Loud rejection** — a granted permission that cannot be consumed
   *   safely ({@link PluginAbilityRenderRejectionError}), whether the
   *   snapshot read detected grant-table corruption or the factory refused
   *   a template. This is the single handling site for that rejection: the
   *   structured warning below is the debuggability of the resulting 403,
   *   so it names the plugin, the permission, the offending variable, and
   *   the unit coordinates (ids only) before the typed error is mapped to
   *   `ForbiddenException`.
   */
  private async buildPluginAbility(actor: PluginActor): Promise<AppAbility> {
    try {
      const snapshot = await this.permissionsService.getPluginGrantSnapshot(actor.pluginId, actor.unit);

      if (!snapshot) {
        this.logger.warn(
          `Plugin actor '${actor.pluginId}' has no Plugin row; resolving a no-rule ability (denies everything)`,
        );

        return this.abilityFactory.createDenyAll();
      }

      return this.abilityFactory.createForPlugin(snapshot);
    } catch (error) {
      if (error instanceof PluginAbilityRenderRejectionError) {
        this.logger.warn(
          `Plugin ability rejected (${error.reason}): permission '${error.permissionSlug}' for plugin ` +
            `'${error.pluginSlug}' (${error.pluginId})` +
            (error.variable ? ` references out-of-context template variable '${error.variable}'` : '') +
            ` while operating as unit ${JSON.stringify(error.unit)}`,
        );

        throw new ForbiddenException(t('common.forbidden.action'));
      }

      throw error;
    }
  }
}

/**
 * Whether {@link AbilityService.resolveAbilitiesForActor} can resolve this actor
 * kind in the current slice — i.e. the non-throwing cases of its `switch`.
 *
 * Single source of truth for that decision: the priming middleware uses it to
 * gate resolution (priming `[]` for the rest), so the "resolvable kinds" set is
 * expressed once instead of being duplicated there. Keep in lock-step with the
 * `switch` above when a deferred kind (`anonymous`) gains a surface.
 */
export function isResolvableActor(actor: Actor): boolean {
  return isUserActor(actor) || isApiKeyActor(actor) || isSystemActor(actor) || isPluginActor(actor);
}

/**
 * Exhaustiveness guard. The `Actor` union is closed today; this catches a
 * forged or future actor kind at runtime instead of silently returning
 * `undefined`.
 */
function assertNeverActor(actor: never): never {
  throw new Error(`Unhandled actor kind: ${JSON.stringify(actor)}`);
}
