import { DatabaseService, SystemRole, Theme } from '@bge/database';
import { ServiceAccountService } from '@bge/services';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly serviceAccount: ServiceAccountService,
  ) {}

  async provisionNewUser(userId: string): Promise<void> {
    // Event payloads carry minimal snapshots (#57); load the full row for the
    // fields provisioning needs (firstName/lastName drive the display name).
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`.trim()
      : user.username;

    // Service accounts are real User rows, so they must be excluded or they'd
    // shift the first human out of this branch.
    const usersCount = await this.db.user.count({ where: { isServiceAccount: false } });
    const isFirstHuman = usersCount === 1;

    // Two separate questions, deliberately not one comparison (#410). "Is this
    // the first human" drives the side effects below — service-account birth,
    // `emailVerified`, the better-auth `role` column. "Which roles do they
    // get" is this list. A setup wizard changes the second and not the first,
    // so a single `roleName === Owner` test would make the wizard's first
    // change silently skip system birth.
    // Elevation is additive: the first human holds `User` AND `Owner`, never
    // `Owner` alone (#410). Subtraction only works when the base is held
    // independently — strip `Owner` from an Owner-only actor and what remains
    // is LESS than an ordinary user, missing `read:game`, `create:household`
    // and `read:households`. Behaviourally a no-op for the ability layer
    // today: `manage:all` subsumes everything `User` grants, and no seeded
    // role permission is inverted, so the extra rules have nothing to collide
    // with under CASL's last-rule-wins (asserted by the seed invariant in
    // apps/api-e2e/src/auth/role-model-invariants.spec.ts).
    const roleNames = isFirstHuman ? [SystemRole.User, SystemRole.Owner] : [SystemRole.User];

    // Resolved BEFORE the transaction opens. An unseeded catalog is a constant
    // of the deployment, not a property of this signup, so discovering it
    // after two inserts would make every signup against a half-seeded database
    // pay those writes plus a rollback to learn the same thing.
    const assignments = await this.resolveRoleAssignments(user.id, roleNames);

    await this.db.$transaction(async (db) => {
      await db.userPreferences.create({
        data: { userId: user.id, theme: Theme.System, emailNotifications: {}, pushNotifications: {} },
      });
      await db.userProfile.create({ data: { userId: user.id, displayName } });
      await db.userRole.createMany({ data: assignments });

      // `isFirstHuman`, deliberately NOT `roleNames.includes(Owner)`. The two
      // are extensionally identical today, so no test can tell them apart —
      // this is held by review until provisioning can hand the first human a
      // set without `Owner`, which is what a setup wizard introduces. Do not
      // "simplify" it back to reading the role set.
      if (isFirstHuman) {
        await db.user.update({
          where: { id: user.id },
          data: { role: SystemRole.Admin.toLowerCase(), emailVerified: true },
        });
      }
    });

    if (isFirstHuman) {
      // Same reasoning as the branch above: keyed on first-human-ness, not on
      // the role set that currently implies it.
      // System birth: the first human gets the system its service principal.
      // Idempotent, so re-provisioning or a future wizard is harmless.
      await this.serviceAccount.ensure();
    }

    this.logger.debug(`Provisioned user ${user.id} with role(s) '${roleNames.join("', '")}'`);
  }

  /**
   * The `UserRole` rows to write for `roleNames`, in that order.
   *
   * Ordered by the name list rather than by whatever order the lookup came
   * back in: an `IN` query carries no `ORDER BY`, so mapping the result
   * directly would leave the physical row order to the database's heap — the
   * same class of dependency #410 removes from the read side.
   *
   * Throws on a name the catalog does not hold. The `findMany` here cannot
   * throw the way the `findUniqueOrThrow` it replaced did, and without this an
   * unseeded catalog would hand back a short list and provision an actor
   * holding fewer roles than its role set claims, silently.
   *
   * Throws on a repeated name too, rather than deduplicating it. The argument
   * is a set expressed as an ordered list, and `@@unique([userId, roleId])`
   * makes a repeat fatal anyway — as a P2002 raised inside the transaction, in
   * a handler detached from the request, where no client sees it. Silently
   * collapsing the duplicate would instead hide the caller's bug, which is the
   * opposite of what a seam about to grow a computed caller (#422) wants.
   */
  private async resolveRoleAssignments(
    userId: string,
    roleNames: readonly SystemRole[],
  ): Promise<{ userId: string; roleId: string }[]> {
    const repeated = [...new Set(roleNames.filter((name, index) => roleNames.indexOf(name) !== index))];

    if (repeated.length > 0) {
      throw new Error(
        `Cannot provision user ${userId}: role(s) requested more than once: ${repeated.join(', ')}. ` +
          `Each role must appear at most once in a provisioned role set.`,
      );
    }

    const roles = await this.db.role.findMany({
      where: { name: { in: [...roleNames] } },
      select: { id: true, name: true },
    });
    const roleIdsByName = new Map(roles.map((role) => [role.name, role.id]));

    return roleNames.map((name) => {
      const roleId = roleIdsByName.get(name);

      if (roleId === undefined) {
        throw new Error(
          `Cannot provision user ${userId}: role '${name}' is missing from the catalog. ` +
            `The roles seed (prisma/seeds/roles-permissions.seed.ts) has not run against this database.`,
        );
      }

      return { userId, roleId };
    });
  }
}
