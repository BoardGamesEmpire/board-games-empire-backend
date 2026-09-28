import { Action, DatabaseService, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertHouseholdExists } from '../household-access.helpers';

export const HOUSEHOLD_PATH_PARAM_KEY = 'household:path-param';
export const ALLOWS_DELETED_HOUSEHOLD_KEY = 'household:allows-deleted';

/**
 * Names the route parameter that carries the household id on a controller
 * {@link HouseholdLivenessGuard} guards: `id` on `/households/:id`,
 * `householdId` under `/households/:householdId/members`. Declared rather than
 * guessed, because a controller whose `:id` is not a household would otherwise
 * be probed for the wrong row.
 */
export const HouseholdPathParam = (name: string) => SetMetadata(HOUSEHOLD_PATH_PARAM_KEY, name);

/**
 * Exempts one route from {@link HouseholdLivenessGuard}: a route whose target is
 * a deleted household, and which answers for that itself.
 */
export const AllowsDeletedHousehold = () => SetMetadata(ALLOWS_DELETED_HOUSEHOLD_KEY, true);

/**
 * Answers 404 for a household that is missing or soft-deleted, on every route
 * that names one, before `PoliciesGuard` runs (#299).
 *
 * The order is the mechanism. `PoliciesGuard` is type-level: it asks whether
 * the actor holds ANY rule for the action and subject, because a route cannot
 * read the row before it is fetched. A soft delete drops the deleted household
 * from its members' ability graphs, so an owner whose only household it was
 * holds no `update` or `delete` rule on `Household` at all and was refused 403
 * at the guard, while an owner of a second household passed it and got the
 * service's 404. The status depended on unrelated state. Checked first, the
 * answer is 404 for both, and every answer for a LIVE household is unchanged,
 * a 403 included.
 *
 * Two things this is not:
 *
 * - The authority under concurrency. The probe takes no lock, so a delete can
 *   commit after it. The role transitions re-check inside their lock
 *   (`lockHouseholdForRoleTransition`), and the services keep their own
 *   `assertHouseholdExists` for callers that never come through HTTP.
 * - A new way to learn which households exist. It answers only an actor
 *   every one of whose abilities may `read` Household, which is every user
 *   session: `GET /households/:id` already told that actor 404 for a missing
 *   household and 403 for a hidden live one. Anyone else — an API key scoped
 *   away from households, a plugin with no household grant, an actor with no
 *   abilities — is passed through untouched, and `PoliciesGuard` refuses them
 *   403 whatever the id, exactly as it did before this guard.
 *
 * A route with no household in its path (the list, create) passes untouched.
 * A route whose target IS a deleted household opts out with
 * {@link AllowsDeletedHousehold}.
 */
@Injectable()
export class HouseholdLivenessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(ALLOWS_DELETED_HOUSEHOLD_KEY, targets)) {
      return true;
    }

    const param = this.reflector.getAllAndOverride<string | undefined>(HOUSEHOLD_PATH_PARAM_KEY, targets);

    if (param === undefined) {
      throw new Error(
        `${HouseholdLivenessGuard.name} guards ${context.getClass().name}.${context.getHandler().name} ` +
          `without @HouseholdPathParam, so it cannot tell which route parameter is the household.`,
      );
    }

    const request = context.switchToHttp().getRequest<{ params?: Record<string, string | undefined> }>();
    const householdId = request.params?.[param];

    if (householdId === undefined || !this.alreadyTellsHouseholdsApart()) {
      return true;
    }

    await assertHouseholdExists(this.db, householdId);

    return true;
  }

  /**
   * Whether the actor could already distinguish a missing household from a
   * hidden one through `GET /households/:id`: every primed ability reads
   * Household, the same AND `PoliciesGuard` applies. An empty array is no, not
   * a vacuous yes.
   */
  private alreadyTellsHouseholdsApart(): boolean {
    const abilities = this.abilityService.getCurrentAbilities();

    return abilities.length > 0 && abilities.every((ability) => ability.can(Action.read, ResourceType.Household));
  }
}
