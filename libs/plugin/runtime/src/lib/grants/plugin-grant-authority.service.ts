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

  /**
   * User-scope decisions (household-agnostic): beyond being the decider
   * themself (checked by the caller), the user must belong to at least one
   * household where the plugin is enabled — consent travels with the user
   * across qualifying households, and #211's eager revoke fires when the
   * LAST qualifying association ends.
   */
  async hasQualifyingHouseholdForPlugin(userId: string, pluginId: string): Promise<boolean> {
    const memberships = await this.db.householdMember.findMany({
      where: { userId },
      select: { householdId: true },
    });

    if (memberships.length === 0) {
      return false;
    }

    const qualifying = await this.db.householdPlugin.findFirst({
      where: {
        pluginId,
        enabled: true,
        householdId: { in: memberships.map((membership) => membership.householdId) },
      },
      select: { id: true },
    });

    return qualifying !== null;
  }
}
