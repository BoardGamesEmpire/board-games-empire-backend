import { SystemRole, type Household, type HouseholdMember, type PrismaClient } from '@bge/database';
import type { HouseholdRoleName, SessionActor } from './types.js';

export interface HouseholdRosterEntry {
  readonly actor: SessionActor;
  readonly role: HouseholdRoleName;
}

export interface HouseholdWithMembersOptions {
  /** Becomes `createdById` and the household's `HouseholdOwner` member. */
  readonly owner: SessionActor;

  /** Additional members, in order. The owner must not reappear here. */
  readonly members?: readonly HouseholdRosterEntry[];

  readonly name?: string;
  readonly description?: string;
}

export interface HouseholdRosterMember {
  readonly member: HouseholdMember;
  readonly role: HouseholdRoleName;
}

export interface HouseholdFixture {
  readonly household: Household;
  readonly owner: HouseholdRosterMember;
  /** The non-owner roster, in input order. */
  readonly members: readonly HouseholdRosterMember[];
}

export interface RosterEntryPlan {
  readonly userId: string;
  readonly role: HouseholdRoleName;
}

export interface RosterPlan {
  readonly ownerEntry: RosterEntryPlan;
  readonly memberEntries: readonly RosterEntryPlan[];
}

/**
 * Pure roster validation/normalization, separated for unit testing: the
 * owner is folded in as a `HouseholdOwner` entry (mirroring what the real
 * create path persists), and duplicate users are rejected up front with the
 * constraint they would have tripped — a P2002 on `[householdId, userId]`
 * from deep inside a transaction is a far worse error to hand a spec
 * author.
 */
export function planRoster(ownerUserId: string, members: readonly RosterEntryPlan[] = []): RosterPlan {
  const seen = new Set<string>([ownerUserId]);

  for (const entry of members) {
    if (seen.has(entry.userId)) {
      throw new Error(
        `Duplicate roster user '${entry.userId}': each user may appear at most once per household ` +
          `(unique [householdId, userId]), and the owner is already a member.`,
      );
    }

    seen.add(entry.userId);
  }

  return {
    ownerEntry: { userId: ownerUserId, role: SystemRole.HouseholdOwner },
    memberEntries: members,
  };
}

/**
 * Arranges a household with a role-scoped roster DIRECTLY in the database —
 * deliberately not through `POST /households` and the member endpoints.
 * Those are product behavior under test elsewhere (#257); a fixture that
 * exercised them would couple every consuming suite's setup to their
 * correctness and pay an HTTP round-trip per roster row. Direct arrangement
 * is sanctioned plumbing under #255's revised D-6.
 *
 * ORDERING RULE (#256 revised decision 5): call this BEFORE any of the
 * roster actors issue their first authenticated request. The ability cache
 * populates lazily per user on first use and the test process cannot evict
 * it; membership arranged after an actor has already made a request is
 * invisible to that actor until something server-side evicts them.
 */
export async function createHouseholdWithMembers(
  prisma: PrismaClient,
  options: HouseholdWithMembersOptions,
): Promise<HouseholdFixture> {
  const plan = planRoster(
    options.owner.user.id,
    (options.members ?? []).map((entry) => ({ userId: entry.actor.user.id, role: entry.role })),
  );

  const distinctRoleNames = [
    ...new Set<HouseholdRoleName>([plan.ownerEntry.role, ...plan.memberEntries.map((entry) => entry.role)]),
  ];

  const roles = await prisma.role.findMany({
    where: { name: { in: distinctRoleNames } },
    select: { id: true, name: true },
  });

  const roleIdByName = new Map(roles.map((role) => [role.name, role.id]));

  const missing = distinctRoleNames.filter((name) => !roleIdByName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Role(s) ${missing.join(', ')} are not in the roles table — the reference seed ` +
        `(prisma/seeds/roles-permissions.seed.ts) did not run, or the isolation sweep stopped preserving it.`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const household = await tx.household.create({
      data: {
        name: options.name ?? `e2e-household-${options.owner.user.id}`,
        description: options.description,
        createdById: plan.ownerEntry.userId,
      },
    });

    const persistEntry = async (entry: RosterEntryPlan): Promise<HouseholdRosterMember> => {
      const member = await tx.householdMember.create({
        data: { householdId: household.id, userId: entry.userId },
      });

      // Total over the plan's role names — verified before the transaction;
      // rechecked here so a future refactor cannot silently reintroduce a cast.
      const roleId = roleIdByName.get(entry.role);
      if (roleId === undefined) {
        throw new Error(`Role '${entry.role}' vanished between lookup and persistence — this should be unreachable.`);
      }

      await tx.householdRole.create({
        data: { householdMemberId: member.id, roleId },
      });

      return { member, role: entry.role };
    };

    const owner = await persistEntry(plan.ownerEntry);

    const members: HouseholdRosterMember[] = [];
    for (const entry of plan.memberEntries) {
      members.push(await persistEntry(entry));
    }

    return { household, owner, members };
  });
}
