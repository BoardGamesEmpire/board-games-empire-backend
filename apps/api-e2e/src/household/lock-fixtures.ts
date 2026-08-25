import type { PrismaClient } from '@bge/database';
import type { HouseholdRoleName } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';

/**
 * Rows and probe statements shared by the LOCK MECHANICS specs (#239), which
 * need something real to contend over and nothing else.
 *
 * Deliberately not `@bge/testing-e2e`'s `createHouseholdWithMembers`: that
 * factory takes `SessionActor`s, because every suite it serves goes on to make
 * authenticated requests as those actors. The barrier specs make no requests at
 * all — they speak to Postgres directly — so paying three signups and the
 * provisioning wait per test would buy nothing. Faking `SessionActor`s to reach
 * the factory would be worse: a credential nobody can authenticate with, shaped
 * like one that works.
 *
 * The HTTP race spec in this same folder uses the real factories, as it must.
 */
/**
 * What `deleteHousehold` does to a household row, as a statement a barrier can
 * hold open. Prisma writes `SET deleted_at = $1, updated_at = $2`; what matters
 * for every lock question here is that both columns are non-key, which is what
 * makes the write a `FOR NO KEY UPDATE`.
 *
 * Defined once because two suites probe against it — the share lock must block
 * it, the role-transition lock must block it — and a copy that drifted would
 * change what one of them proves without failing the other.
 */
export const SOFT_DELETE_HOUSEHOLD =
  'UPDATE households SET deleted_at = now(), updated_at = now() WHERE id = $1 RETURNING id';

/**
 * The lock a `household_members` insert takes on its parent row implicitly,
 * through the foreign key. Stated explicitly so a spec can ask what that mode
 * does — it is the mode that does NOT close the admission race, and the one a
 * role transition deliberately leaves unblocked.
 */
export const FK_PARENT_LOCK = 'SELECT h.id FROM households h WHERE h.id = $1 FOR KEY SHARE';

export interface LockFixtureMember {
  readonly memberId: string;
  readonly userId: string;
  readonly role: HouseholdRoleName;
}

export interface LockFixture {
  readonly householdId: string;
  readonly members: readonly LockFixtureMember[];
}

/** The member holding `role`, failing loudly rather than returning undefined. */
export function memberWithRole(fixture: LockFixture, role: HouseholdRoleName, occurrence = 0): LockFixtureMember {
  const matches = fixture.members.filter((member) => member.role === role);
  const match = matches[occurrence];

  if (!match) {
    throw new Error(
      `Fixture has no ${role} at index ${occurrence} (roles: ${fixture.members.map((m) => m.role).join(', ')})`,
    );
  }

  return match;
}

/**
 * Creates a household with one member per requested role, plus the users those
 * members belong to.
 *
 * Users are written directly rather than signed up: these specs never
 * authenticate, so a `User` row satisfying the foreign keys is the whole
 * requirement. No `UserRole` is granted, which also keeps the fixture clear of
 * the first-human-becomes-Owner provisioning rule that the actor factories
 * exist to manage.
 */
export async function arrangeHouseholdWithRoles(
  prisma: PrismaClient,
  roles: readonly HouseholdRoleName[],
): Promise<LockFixture> {
  if (roles.length === 0) {
    throw new Error('A lock fixture needs at least one member — the household creator is one of them.');
  }

  const roleIdByName = await resolveRoleIds(prisma, roles);

  return prisma.$transaction(async (tx) => {
    const users = await Promise.all(roles.map(() => createUser(tx)));
    const creator = users[0];

    const household = await tx.household.create({
      data: { name: `lock-fixture-${randomUUID()}`, createdById: creator.id },
    });

    const members: LockFixtureMember[] = [];

    for (const [index, role] of roles.entries()) {
      const user = users[index];
      const roleId = roleIdByName.get(role);

      if (roleId === undefined) {
        throw new Error(`Role '${role}' vanished between lookup and persistence — this should be unreachable.`);
      }

      const member = await tx.householdMember.create({ data: { householdId: household.id, userId: user.id } });

      await tx.householdRole.create({ data: { householdMemberId: member.id, roleId } });

      members.push({ memberId: member.id, userId: user.id, role });
    }

    return { householdId: household.id, members };
  });
}

/** A household with no members, for the share-lock specs. */
export async function arrangeEmptyHousehold(prisma: PrismaClient): Promise<{ householdId: string; userId: string }> {
  const user = await createUser(prisma);
  const household = await prisma.household.create({
    data: { name: `lock-fixture-${randomUUID()}`, createdById: user.id },
  });

  return { householdId: household.id, userId: user.id };
}

type UserWriter = Pick<PrismaClient, 'user'>;

async function createUser(client: UserWriter): Promise<{ id: string }> {
  const handle = randomUUID();

  return client.user.create({
    data: { username: `lock-${handle}`, email: `lock-${handle}@example.test` },
    select: { id: true },
  });
}

async function resolveRoleIds(prisma: PrismaClient, roles: readonly HouseholdRoleName[]): Promise<Map<string, string>> {
  const wanted = [...new Set(roles)];
  const rows = await prisma.role.findMany({ where: { name: { in: wanted } }, select: { id: true, name: true } });
  const byName = new Map(rows.map((row) => [row.name, row.id]));
  const missing = wanted.filter((name) => !byName.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Role(s) ${missing.join(', ')} are not in the roles table — the reference seed ` +
        `(prisma/seeds/roles-permissions.seed.ts) did not run, or the isolation sweep stopped preserving it.`,
    );
  }

  return byName;
}
