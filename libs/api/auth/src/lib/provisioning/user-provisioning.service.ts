import { DatabaseService, Prisma, PROVISIONED_HUMAN_WHERE, SystemRole, Theme } from '@bge/database';
import { PermissionsService } from '@bge/permissions';
import { ServiceAccountService } from '@bge/services';
import { Injectable, Logger } from '@nestjs/common';

/**
 * The Owner election's advisory lock. Postgres derives the 64-bit key from the
 * name (`hashtextextended`), as it does for the bootstrap lock and the plugin
 * unit-scope locks, so no caller computes the key itself.
 */
const OWNER_ELECTION_LOCK_NAME = 'bge:owner-election';

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly serviceAccount: ServiceAccountService,
    private readonly permissions: PermissionsService,
  ) {}

  async provisionNewUser(userId: string): Promise<void> {
    // Event payloads carry minimal snapshots (#57); load the full row for the
    // fields provisioning needs (firstName/lastName drive the display name).
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });

    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`.trim()
      : user.username;

    // An anonymous user is a temporary, account-less guest (#484), and it must
    // never take the first-human seat. Guests are meant to arrive by
    // invitation, which needs an account holder first, but nothing enforces
    // that: `POST /api/auth/sign-in/anonymous` is open (#489), so on an empty
    // install the first anonymous sign-in would otherwise be made Owner and
    // handed better-auth's admin role.
    const isAnonymous = user.isAnonymous === true;

    // Is this the first human? Asked of what provisioning writes, never of the
    // user rows (#430). better-auth commits the row before this handler runs,
    // so two first signups can both be committed before either one looks: a
    // count sees two humans and elects nobody, and the install never gets an
    // Owner. The seat is taken once any human holds a global role.
    //
    // An unlocked look first. Once someone is provisioned the seat stays
    // taken, so every signup after an install's first few answers here and
    // never touches the election lock. The look is repeated under the lock.
    const seatMayBeOpen = !isAnonymous && !(await this.ownerSeatTaken(this.db));

    // Two separate questions, deliberately not one comparison (#410). "Is this
    // the first human" drives the side effects below — service-account birth,
    // `emailVerified`, the better-auth `role` column. "Which roles do they
    // get" is the role set. A setup wizard changes the second and not the first,
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
    // An anonymous user holds `AnonymousUser` INSTEAD of `User`, never beside
    // it: the row's roles are resolved like anyone else's, so `User` here would
    // hand an anonymous session everything a signed-in user can do (#484).
    const baseRoleNames = isAnonymous ? [SystemRole.AnonymousUser] : [SystemRole.User];
    const firstHumanRoleNames = [SystemRole.User, SystemRole.Owner];

    // Resolved BEFORE the transaction opens. An unseeded catalog is a constant
    // of the deployment, not a property of this signup, so discovering it
    // after two inserts would make every signup against a half-seeded database
    // pay those writes plus a rollback to learn the same thing. Both sets while
    // the seat may be open: which one this signup writes is only known once it
    // holds the election lock. So while the seat is open, a catalog without
    // `Owner` fails every signup, not only the first one — each is a candidate
    // until someone is provisioned.
    const baseAssignments = await this.resolveRoleAssignments(user.id, baseRoleNames);
    const firstHumanAssignments = seatMayBeOpen
      ? await this.resolveRoleAssignments(user.id, firstHumanRoleNames)
      : null;

    const isFirstHuman = await this.db.$transaction(async (db) => {
      const elected = firstHumanAssignments !== null && (await this.holdOwnerElection(db));

      await db.userPreferences.create({
        data: { userId: user.id, theme: Theme.System, emailNotifications: {}, pushNotifications: {} },
      });
      await db.userProfile.create({ data: { userId: user.id, displayName } });
      await db.userRole.createMany({ data: elected ? firstHumanAssignments : baseAssignments });

      // First-human-ness, deliberately NOT `roleNames.includes(Owner)`. The
      // two are extensionally identical today, so no test can tell them apart —
      // this is held by review until provisioning can hand the first human a
      // set without `Owner`, which is what a setup wizard introduces. Do not
      // "simplify" it back to reading the role set.
      if (elected) {
        await db.user.update({
          where: { id: user.id },
          data: { role: SystemRole.Admin.toLowerCase(), emailVerified: true },
        });
      }

      return elected;
    });

    // Provisioning assigns roles, and every role assignment evicts the user's
    // graph (`PermissionsService.invalidateUser`). Today this removes nothing:
    // a graph read before the commit above held no global role, and a user
    // graph without one is never cached (#490). That rule, not this eviction,
    // is what stops a pre-commit read outliving provisioning, since such a
    // read can write the cache after the eviction. This covers a provisioning
    // that writes roles in more than one transaction, as a setup wizard might:
    // after its first commit the graph holds a role and is cached.
    await this.permissions.invalidateUser(user.id);

    if (isFirstHuman) {
      // Same reasoning as the branch above: keyed on first-human-ness, not on
      // the role set that currently implies it.
      // System birth: the first human gets the system its service principal.
      // Idempotent, so re-provisioning or a future wizard is harmless.
      await this.serviceAccount.ensure();
    }

    const roleNames = isFirstHuman ? firstHumanRoleNames : baseRoleNames;
    this.logger.debug(`Provisioned user ${user.id} with role(s) '${roleNames.join("', '")}'`);
  }

  /**
   * The election itself, inside the provisioning transaction: take the lock,
   * then look again.
   *
   * The lock is what makes the answer hold. Without it, two transactions that
   * both look before either writes would both find the seat open and both
   * elect — the two-Owner case that counting user rows could never reach. With
   * it, whichever takes the lock second waits for the first to commit, and
   * then sees its roles. That second look sees the commit because the
   * transaction runs at READ COMMITTED, where every statement takes a fresh
   * snapshot. At REPEATABLE READ the snapshot would come from the lock
   * statement, before the wait, and both would elect.
   */
  private async holdOwnerElection(db: Prisma.TransactionClient): Promise<boolean> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${OWNER_ELECTION_LOCK_NAME}, 0))`;
    return !(await this.ownerSeatTaken(db));
  }

  private async ownerSeatTaken(db: Prisma.TransactionClient | DatabaseService): Promise<boolean> {
    const provisioned = await db.user.findFirst({ where: PROVISIONED_HUMAN_WHERE, select: { id: true } });
    return provisioned !== null;
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
            `The roles seed (libs/database/src/lib/seeds/roles-permissions.seed.ts) has not run against this database.`,
        );
      }

      return { userId, roleId };
    });
  }
}
