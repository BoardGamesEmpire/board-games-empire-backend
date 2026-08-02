import { DatabaseService, SystemRole } from '@bge/database';
import { Injectable } from '@nestjs/common';

/**
 * Grant-time authority predicates: the per-unit analog of
 * install-validation step 12. The consent-time delegation model is
 * security-equivalent to runtime intersection only if the decider actually
 * HOLDS the authority being delegated — these queries are that
 * verification, evaluated once, at decision time.
 *
 * Deliberately direct role-membership queries rather than CASL resolution:
 * the question is structural ("is this user a household admin of X"), not
 * conditional, and keeping `@bge/plugin` off `@bge/permissions` preserves
 * the dependency direction this design relies on (the permissions lib reads
 * `PluginGrant` via the database directly).
 *
 * User-scope decisions need no predicate HERE (#225 uniform enablement):
 * the authority question reduces to conditions `PluginGrantService.decide()`
 * already enforces — the decider is the subject, the plugin is not
 * tombstoned, and the active manifest requests the permission at user
 * scope. Household membership is irrelevant to both the decision and its
 * validity; the former `hasQualifyingHouseholdForPlugin` anchor was the
 * model that decision rejected.
 */
@Injectable()
export class PluginGrantAuthorityService {
  constructor(private readonly db: DatabaseService) {}

  /** Server-scope decisions: the decider holds a server admin role. */
  async isServerAdmin(userId: string): Promise<boolean> {
    const assignment = await this.db.userRole.findFirst({
      where: { userId, role: { name: { in: [SystemRole.Owner, SystemRole.Admin] } } },
      select: { id: true },
    });

    return assignment !== null;
  }

  /** Household-scope decisions: the decider is an owner/admin MEMBER of the anchoring household. */
  async isHouseholdAdmin(userId: string, householdId: string): Promise<boolean> {
    const membership = await this.db.householdMember.findFirst({
      where: {
        userId,
        householdId,
        role: { role: { name: { in: [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin] } } },
      },
      select: { id: true },
    });

    return membership !== null;
  }
}
