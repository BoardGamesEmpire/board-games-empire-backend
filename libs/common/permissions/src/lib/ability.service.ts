import {
  type Actor,
  AuditContextService,
  isAnonymousActor,
  isApiKeyActor,
  isPluginActor,
  isSystemActor,
  isUserActor,
  type PluginActor,
} from '@bge/actor-context';
import { Action, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { subject } from '@casl/ability';
import { accessibleBy, createPrismaAbility, type WhereInput } from '@casl/prisma';
import { ForbiddenException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { AbilityFactory } from './ability.factory';
import { AbilityContextNotPrimedError } from './errors/ability-context-not-primed.error';
import { PluginAbilityRenderRejectionError } from './errors/plugin-ability-render-rejection.error';
import type { AppAbility, ModelResourceType, SubjectInstance } from './interfaces';
import { PermissionsService } from './permissions.service';
import { AbilityContextInternalService } from './services/ability-context-internal.service';

/** Whether one user's ability allows `action` on an `instance`, as {@link AbilityService.userAbilityWithin} built it. */
export type UserAbilityCheck = <TResource extends ModelResourceType>(
  action: Action,
  resourceType: TResource,
  instance: SubjectInstance<TResource>,
  field?: string,
) => boolean;

/**
 * Central ability-resolution surface for every actor kind.
 *
 * Resolution model (issue #68):
 * - `user`     → `[userAbility]`
 * - `anonymous`→ `[userAbility]`, built from the anonymous user's own row
 *                exactly as for `user`. An anonymous user is a real `User` row
 *                — a temporary guest — and provisioning gives it
 *                `AnonymousUser` INSTEAD of `User` (#484); a guest's event
 *                rights arrive through the same row, on its attendee roles.
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
 * - `external` → resolution throws (see {@link resolveAbilitiesForActor}); it
 *   is audit-only and has no query surface.
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
   *
   * `field` is for a read that serves a column some grants leave out. See
   * {@link getResourceConditionsForAbilities}.
   */
  getCurrentResourceConditions<TResource extends ModelResourceType>(
    resourceType: TResource,
    action: Action,
    field?: string,
  ): WhereInput<TResource>[] {
    return this.getResourceConditionsForAbilities(this.getCurrentAbilities(), resourceType, action, field);
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
   *
   * With a `field`, each ability's clause is built only from its rules that
   * admit that column. A rule's field list says which columns it reads, but
   * `accessibleBy` reads rows and ignores it, so a grant limited to a few
   * columns would otherwise widen a read that serves one it leaves out. A
   * route gated on `can(action, type, field)` may pass on one narrow rule, and
   * its rows must come from the rules that could pass it, not from every rule
   * on the type. Denials that bind no field still apply.
   */
  getResourceConditionsForAbilities<TResource extends ModelResourceType>(
    abilities: AppAbility[],
    resourceType: TResource,
    action: Action,
    field?: string,
  ): WhereInput<TResource>[] {
    if (abilities.length === 0) {
      throw new ForbiddenException(t('common.forbidden.access'));
    }

    try {
      return abilities.map((ability) =>
        accessibleBy(
          field === undefined ? ability : rulesAdmittingField(ability, action, resourceType, field),
          action,
        ).ofType(resourceType),
      );
    } catch (error) {
      this.logger.error(
        `Failed to build '${action}' conditions for ${resourceType}; treating as denied.`,
        error instanceof Error ? error.stack : String(error),
      );

      throw new ForbiddenException(t('common.forbidden.access'));
    }
  }

  /**
   * The instance half of a route's `@CheckPolicies` type check: every primed
   * ability must allow `action` on THIS `instance` of `resourceType`, or the
   * request is forbidden. The guard's `ability.can(action, ResourceType.X)`
   * answers true the moment any rule for the pair exists, conditions unread,
   * which is all a route can ask before it knows the row. A mutation of an
   * existing row binds the conditions in its query instead
   * ({@link getCurrentResourceConditions}); a create has no row for a filter
   * to bind, so the service builds the subject it is about to write — the
   * request's coordinates plus what the parent row supplies — and asks here.
   *
   * Same AND-across-abilities rule as `PoliciesGuard`: for an API key the
   * owner AND the key must both allow it, and an empty array is a denial,
   * never a vacuous pass. A condition the matcher cannot evaluate is logged
   * and denied rather than surfaced as a 500, mirroring
   * {@link getResourceConditionsForAbilities}.
   *
   * The instance is typed from the schema ({@link SubjectInstance}), so a key
   * no model has fails to compile rather than reaching the matcher as a field
   * no condition names. It is `subject()`-tagged so its type resolves by the
   * tag rather than by a plain object's constructor. Relation conditions reach
   * it as nested objects (`{ event: { householdId } }` on the instance for an
   * `{ event: { is: { householdId } } }` condition), and the matcher accepts
   * only that operator form — the `{ relation: { field } }` shorthand Prisma
   * also takes in a query throws here. Every catalog grant writes its
   * traversals in the operator form, and `findShorthandRelationConditions`
   * (`@bge/database`) fails the catalog's specs on one that does not (#458).
   *
   * `field` names the column the action changes. A permission bound to fields
   * matches a check naming one of them and no other, and matches EVERY check
   * that names none, so two permissions on one action and resource type are
   * told apart only by a check that names its field: approving an invite and
   * revoking one (#166).
   */
  assertCurrentActorCan<TResource extends ModelResourceType>(
    action: Action,
    resourceType: TResource,
    instance: SubjectInstance<TResource>,
    field?: string,
  ): void {
    if (!this.currentActorCan(action, resourceType, instance, field)) {
      throw new ForbiddenException(t('common.forbidden.action'));
    }
  }

  /**
   * The question {@link assertCurrentActorCan} asks, answered rather than
   * thrown: for a service that picks between two permissions, such as an
   * invite opened directly or one opened for approval (#166). Every primed ability
   * must allow it, and an empty array allows nothing.
   *
   * A condition the matcher cannot evaluate is logged and refused with 403, as
   * the assert refuses it, never answered `false`: a caller that took `false`
   * as "no" would move on to its other permission, and a broken condition
   * would quietly change what the request does instead of refusing it.
   */
  currentActorCan<TResource extends ModelResourceType>(
    action: Action,
    resourceType: TResource,
    instance: SubjectInstance<TResource>,
    field?: string,
  ): boolean {
    return this.allows(this.getCurrentAbilities(), action, resourceType, instance, field);
  }

  /**
   * {@link currentActorCan}'s question, asked of another user: `userId`'s own
   * ability, as a check that answers whether it allows `action` on an
   * `instance`. For a decision about someone else's standing, as an accept
   * asks whether an invite's sender could still send it (#747). The ability
   * is built once, so a caller with two questions loads the graph once.
   *
   * It is built from the graph `tx` reads now, never from the cache
   * ({@link PermissionsService.loadUserRoleGraphWithin}), so a role change
   * that committed a moment ago is already in it. Only their user ability is
   * asked: whatever an API key of theirs held when it acted, they hold no more
   * than this. A user with no graph, deleted or banned since, is allowed
   * nothing.
   *
   * A condition the matcher cannot evaluate is a fault in that user's grants,
   * not anything the acting user did, so it answers 500 rather than the 403
   * {@link currentActorCan} gives: the acting user was never refused anything.
   */
  async userAbilityWithin(tx: Prisma.TransactionClient, userId: string): Promise<UserAbilityCheck> {
    const graph = await this.permissionsService.loadUserRoleGraphWithin(tx, userId);
    const abilities = [this.abilityFactory.createForUser(graph)];

    return (action, resourceType, instance, field) =>
      this.allows(abilities, action, resourceType, instance, field, () => {
        throw new InternalServerErrorException(t('errors.permission.condition_unevaluable'));
      });
  }

  /** Whether every ability allows it, with a matcher failure refused rather than answered `false`. */
  private allows<TResource extends ModelResourceType>(
    abilities: readonly AppAbility[],
    action: Action,
    resourceType: TResource,
    instance: SubjectInstance<TResource>,
    field?: string,
    refuse: () => never = () => {
      throw new ForbiddenException(t('common.forbidden.action'));
    },
  ): boolean {
    try {
      return (
        abilities.length > 0 &&
        abilities.every((ability) => ability.can(action, subject(resourceType, instance), field))
      );
    } catch (error) {
      this.logger.error(
        `Failed to evaluate '${action}' on a ${resourceType} instance; treating as denied.`,
        error instanceof Error ? error.stack : String(error),
      );

      return refuse();
    }
  }

  /**
   * Resolves and primes the current actor's abilities into CLS. The single
   * public priming entry point — every transport populator (HTTP middleware,
   * BullMQ worker host, …) calls this once the actor is in CLS.
   *
   * Primes only the *current* actor (read from CLS); there is no arbitrary-actor
   * parameter, so this cannot forge an ability set. A request with no actor
   * (no session) and a kind with no ability surface (`external`) prime `[]`,
   * which the query layer and PoliciesGuard treat as denial — never an
   * unfiltered query. Resolution failures (revoked key, DB error) propagate to
   * the caller (→ request/job failure) rather than degrading silently.
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
      case 'anonymous':
        return [await this.buildUserAbility(actor.userId)];

      case 'apiKey':
        return [await this.buildUserAbility(actor.userId), await this.buildApiKeyAbility(actor.apiKeyId)];

      case 'system':
        return [this.abilityFactory.createForSystem(actor.reason)];

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
 * `switch` above: a kind the `switch` resolves but this omits primes `[]` and
 * is denied everything, silently.
 */
export function isResolvableActor(actor: Actor): boolean {
  return (
    isUserActor(actor) ||
    isAnonymousActor(actor) ||
    isApiKeyActor(actor) ||
    isSystemActor(actor) ||
    isPluginActor(actor)
  );
}

/**
 * Exhaustiveness guard. The `Actor` union is closed today; this catches a
 * forged or future actor kind at runtime instead of silently returning
 * `undefined`.
 */
function assertNeverActor(actor: never): never {
  throw new Error(`Unhandled actor kind: ${JSON.stringify(actor)}`);
}

/**
 * An ability holding only `ability`'s rules that a check on `field` consults:
 * allows that read the column, and denials bound to it or to no field. CASL
 * hands them back highest priority first, and a built ability takes its last
 * rule as the highest, so they are reversed to keep a later denial winning.
 *
 * Their fields are dropped once the selection is made. The clause is built
 * with no field named, and CASL skips a field-bound denial in that form, so a
 * conditioned denial of the column would otherwise leave its rows in.
 */
function rulesAdmittingField(ability: AppAbility, action: Action, resourceType: ModelResourceType, field: string) {
  const rules = ability.rulesFor(action, resourceType, field).map((rule) => ({ ...rule.origin, fields: undefined }));

  return createPrismaAbility(rules.reverse()) as AppAbility;
}
