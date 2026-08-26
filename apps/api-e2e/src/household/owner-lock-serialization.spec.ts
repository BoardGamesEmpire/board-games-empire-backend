import { SystemRole } from '@bge/database';
import { expectBlocked, expectNotBlocked, withBarrier, type BarrierConnection } from '../support/lock-barrier';
import { readShippedSql } from '../support/shipped-sql';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import {
  arrangeHouseholdWithRoles,
  FK_PARENT_LOCK,
  memberWithRole,
  SOFT_DELETE_HOUSEHOLD,
  type LockFixture,
} from './lock-fixtures';

/**
 * The mechanics half of #239: what the household's role locks actually do
 * against a real Postgres.
 *
 * None of it is observable from the unit suite. `$queryRaw` is a `jest.fn()`
 * there, so neither statement has ever executed — #248's identifier spec proves
 * they are ADDRESSED correctly (every table and column matches the checked-in
 * Prisma models) and nothing proves they BLOCK. Two failures that gap admits:
 *
 *  - A statement that cannot execute at all. `FOR UPDATE OF hr` names an alias;
 *    if `hr` ever left the FROM list the identifier check still passes and every
 *    owner departure 500s in production.
 *  - A lock that is taken but does not exclude what it must. That is not
 *    hypothetical: writing this suite is what found it (see the re-check case
 *    below), and `lockHouseholdForRoleTransition` is the answer.
 *
 * Statements are LIFTED FROM THE SERVICE'S SOURCE rather than copied here (see
 * `support/shipped-sql.ts`). A copy would keep passing for a statement the
 * application no longer ships, which is the one failure mode a mechanics proof
 * cannot afford.
 */
describe('household role-transition locking', () => {
  const SERVICE = 'libs/api/household/src/lib/member/household-member.service.ts';
  const HELPERS = 'libs/api/household/src/lib/household-access.helpers.ts';

  /** `${householdId}` and `${SystemRole.HouseholdOwner}`, in that order. */
  const ownerLock = readShippedSql(SERVICE, ['householdId', 'SystemRole.HouseholdOwner'], {
    after: 'lockHouseholdOwnerRows',
    matching: /FOR UPDATE OF hr/,
  });

  /**
   * The household-row mutex every role transition takes first, and the admission
   * guard (#276) for the one interaction worth pinning below.
   *
   * Both live in the same file and both bind a single `householdId`, so the
   * locking clause is what says which one was lifted — the parameter check
   * cannot tell them apart, and an anchor that resolved to the wrong one would
   * leave several cases here passing about the wrong statement.
   */
  const transitionLock = readShippedSql(HELPERS, ['householdId'], {
    after: 'lockHouseholdForRoleTransition',
    matching: /FOR NO KEY UPDATE/,
  });

  const shareLock = readShippedSql(HELPERS, ['householdId'], {
    after: 'lockExistingHousehold',
    matching: /FOR SHARE/,
  });

  /**
   * The same owner read with the locking clause removed — the "plain count" the
   * service's comment says would not be enough. Asserting that THIS one does
   * not block is what makes a blocking result meaningful: without it, a test
   * showing contention proves only that something in the statement serializes.
   */
  const unlockedRead = (() => {
    const text = ownerLock.text.replace(/\s*FOR UPDATE OF hr\s*$/, '');

    if (text === ownerLock.text) {
      throw new Error(
        `The shipped statement in ${SERVICE} no longer ends with 'FOR UPDATE OF hr', so this spec cannot ` +
          `derive its unlocked control. If the lock moved or changed mode, this suite must be rewritten ` +
          `around the new one rather than quietly testing the old shape.`,
      );
    }

    return text;
  })();

  let db: TestDatabase;
  let roleIds: Map<string, string>;

  beforeAll(async () => {
    db = createTestDatabase();

    const roles = await db.client.role.findMany({
      where: { name: { in: [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin] } },
      select: { id: true, name: true },
    });

    roleIds = new Map(roles.map((role) => [role.name, role.id]));
  });

  afterAll(async () => {
    await db.close();
  });

  /** Two owners and a plain member — the arrangement most cases below need. */
  const arrangeTwoOwners = (): Promise<LockFixture> =>
    arrangeHouseholdWithRoles(db.client, [
      SystemRole.HouseholdOwner,
      SystemRole.HouseholdOwner,
      SystemRole.HouseholdMember,
    ]);

  const arrangeOwnerAndMember = (): Promise<LockFixture> =>
    arrangeHouseholdWithRoles(db.client, [SystemRole.HouseholdOwner, SystemRole.HouseholdMember]);

  const ownerParams = (householdId: string): readonly unknown[] => [householdId, SystemRole.HouseholdOwner];

  const roleId = (name: SystemRole): string => {
    const id = roleIds.get(name);

    if (id === undefined) {
      throw new Error(`Role '${name}' is not seeded — the reference seed did not run.`);
    }

    return id;
  };

  /** What `transferOwnership` writes: promote the target, demote the actor. */
  const writeTransfer = async (
    connection: BarrierConnection,
    promotedMemberId: string,
    demotedMemberId: string,
  ): Promise<void> => {
    await connection.query('UPDATE household_roles SET role_id = $1 WHERE household_member_id = $2', [
      roleId(SystemRole.HouseholdOwner),
      promotedMemberId,
    ]);
    await connection.query('UPDATE household_roles SET role_id = $1 WHERE household_member_id = $2', [
      roleId(SystemRole.HouseholdAdmin),
      demotedMemberId,
    ]);
  };

  describe('the owner-row lock (FOR UPDATE OF hr)', () => {
    it('executes against the real schema and returns exactly the household owners', async () => {
      // The companion the issue originally scoped as "execute the raw SQL
      // against a real schema, even with no rows", strengthened: it runs
      // against rows, so the joins and the role predicate are exercised too.
      // Every identifier, the alias `hr` names, and the FOR UPDATE target all
      // resolve, or this throws.
      const fixture = await arrangeTwoOwners();
      const owners = fixture.members.filter((member) => member.role === SystemRole.HouseholdOwner);

      await withBarrier(async (barrier) => {
        const rows = await barrier.holder.query<{ household_member_id: string }>(
          ownerLock.text,
          ownerParams(fixture.householdId),
        );

        expect(rows.map((row) => row.household_member_id).sort()).toEqual(owners.map((owner) => owner.memberId).sort());
      });
    });

    it('blocks a second transaction taking it, until the first commits', async () => {
      const fixture = await arrangeTwoOwners();
      const departing = memberWithRole(fixture, SystemRole.HouseholdOwner, 0);
      const staying = memberWithRole(fixture, SystemRole.HouseholdOwner, 1);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        // T1 takes the lock and holds it, then does what `deleteMembership`
        // does to a departing owner: drops that member's HouseholdOwner row.
        await holder.begin();
        const held = await holder.query<{ household_member_id: string }>(
          ownerLock.text,
          ownerParams(fixture.householdId),
        );
        expect(held).toHaveLength(2);

        await holder.query('DELETE FROM household_roles WHERE household_member_id = $1', [departing.memberId]);

        await waiter.begin();
        const pending = waiter.issue<{ household_member_id: string }>(
          ownerLock.text,
          ownerParams(fixture.householdId),
          'the second transaction taking the owner lock',
        );

        await expectBlocked(barrier, pending);

        await holder.commit();

        // Once released, T2 sees T1's committed result rather than the
        // pre-image it would have read under READ COMMITTED without the lock.
        // One owner left is precisely the state at which the last-owner guard
        // refuses the second departure.
        const rows = await pending.result();

        expect(rows).toHaveLength(1);
        expect(rows[0]?.household_member_id).toBe(staying.memberId);

        await waiter.commit();
      });
    });

    it('does not block when the locking clause is removed — the lock is what serializes', async () => {
      const fixture = await arrangeTwoOwners();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(ownerLock.text, ownerParams(fixture.householdId));

        await waiter.begin();
        const pending = waiter.issue<{ household_member_id: string }>(
          unlockedRead,
          ownerParams(fixture.householdId),
          'the same read without FOR UPDATE',
        );

        // Two departures each doing THIS is #157's race: both read the
        // pre-image, both conclude another owner remains, both proceed.
        await expectNotBlocked(barrier, pending);
        await expect(pending.result()).resolves.toHaveLength(2);

        await waiter.commit();
        await holder.commit();
      });
    });

    it('locks only the household it was given, so unrelated households do not serialize', async () => {
      // The `WHERE hm.household_id = $1` predicate, observed rather than read.
      // A lock that took the whole table would satisfy every assertion above
      // and turn one busy household into a queue for all of them.
      const [first, second] = [await arrangeTwoOwners(), await arrangeTwoOwners()];

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(ownerLock.text, ownerParams(first.householdId));

        await waiter.begin();
        const pending = waiter.issue<{ household_member_id: string }>(
          ownerLock.text,
          ownerParams(second.householdId),
          "another household's owner lock",
        );

        await expectNotBlocked(barrier, pending);
        await expect(pending.result()).resolves.toHaveLength(2);

        await waiter.commit();
        await holder.commit();
      });
    });

    it('comes back EMPTY after a concurrent transfer — which is why it cannot serialize this alone', async () => {
      // The finding this suite exists to have made, and the reason
      // `lockHouseholdForRoleTransition` was added.
      //
      // Under READ COMMITTED a blocked locking SELECT does not re-run: it
      // re-checks (EvalPlanQual) only the rows its own snapshot located. The
      // set here is defined by `roles.name` — the column a transfer rewrites —
      // so when the transfer commits, the demoted owner's row is re-checked out
      // of the result and the promoted member's row, never in it, is not added.
      //
      // A departing member's guard therefore observed ZERO owners and deleted
      // the household's only one. This case pins the Postgres behaviour itself,
      // so if it ever changes, the rationale for the household-row lock is
      // re-examined deliberately rather than discovered again the hard way.
      const fixture = await arrangeOwnerAndMember();
      const owner = memberWithRole(fixture, SystemRole.HouseholdOwner);
      const member = memberWithRole(fixture, SystemRole.HouseholdMember);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(ownerLock.text, ownerParams(fixture.householdId));
        await writeTransfer(holder, member.memberId, owner.memberId);

        await waiter.begin();
        const pending = waiter.issue<{ household_member_id: string }>(
          ownerLock.text,
          ownerParams(fixture.householdId),
          "the departing member's owner lock",
        );

        await expectBlocked(barrier, pending);
        await holder.commit();

        // Not one owner. None.
        await expect(pending.result()).resolves.toEqual([]);

        await waiter.commit();
      });
    });
  });

  describe('the household role-transition lock (FOR NO KEY UPDATE)', () => {
    it('executes against the real schema and matches the household row', async () => {
      const fixture = await arrangeOwnerAndMember();

      await withBarrier(async ({ holder }) => {
        const rows = await holder.query<{ id: string }>(transitionLock.text, [fixture.householdId]);

        expect(rows.map((row) => row.id)).toEqual([fixture.householdId]);
      });
    });

    it('blocks a second role transition, and the loser then sees the promoted owner', async () => {
      // The fix, end to end at the SQL level: because the mutex is the
      // household ROW, nothing a transfer writes can move it out of the
      // waiter's result set. The waiter resumes, reads the owner set fresh, and
      // finds the new owner — the state at which a departure is correctly
      // refused as the last owner's.
      const fixture = await arrangeOwnerAndMember();
      const owner = memberWithRole(fixture, SystemRole.HouseholdOwner);
      const member = memberWithRole(fixture, SystemRole.HouseholdMember);

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(transitionLock.text, [fixture.householdId]);
        await holder.query(ownerLock.text, ownerParams(fixture.householdId));
        await writeTransfer(holder, member.memberId, owner.memberId);

        await waiter.begin();
        const pending = waiter.issue<{ id: string }>(
          transitionLock.text,
          [fixture.householdId],
          "the second transition's household lock",
        );

        await expectBlocked(barrier, pending);
        await holder.commit();
        await expect(pending.result()).resolves.toHaveLength(1);

        const owners = await waiter.query<{ household_member_id: string }>(
          ownerLock.text,
          ownerParams(fixture.householdId),
        );

        expect(owners.map((row) => row.household_member_id)).toEqual([member.memberId]);

        await waiter.commit();
      });
    });

    it('blocks the soft-delete, so a household cannot die mid-transition', async () => {
      const fixture = await arrangeOwnerAndMember();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(transitionLock.text, [fixture.householdId]);

        await waiter.begin();
        const pending = waiter.issue<{ id: string }>(SOFT_DELETE_HOUSEHOLD, [fixture.householdId], 'the soft-delete');

        await expectBlocked(barrier, pending);
        await holder.commit();
        await expect(pending.result()).resolves.toHaveLength(1);

        await waiter.commit();
      });
    });

    it('does not block a bare FK reference — FOR KEY SHARE does not conflict with it', async () => {
      // Why `FOR NO KEY UPDATE` rather than `FOR UPDATE`: the mode a foreign key
      // takes on this row implicitly is not blocked, so nothing merely
      // REFERENCING the household waits on a role change.
      //
      // Note what this does NOT say — see the case below. The shipped admission
      // path takes an explicit `FOR SHARE` of its own, and that one does wait.
      const fixture = await arrangeOwnerAndMember();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(transitionLock.text, [fixture.householdId]);

        await waiter.begin();
        const pending = waiter.issue<{ id: string }>(
          FK_PARENT_LOCK,
          [fixture.householdId],
          "a member insert's implicit parent lock",
        );

        await expectNotBlocked(barrier, pending);

        await waiter.commit();
        await holder.commit();
      });
    });

    it('does block the shipped admission guard, which takes FOR SHARE', async () => {
      // The honest counterpart, and the reason it is asserted rather than
      // assumed: `lockExistingHousehold` (#276) takes `FOR SHARE`, which DOES
      // conflict with this mode — so admitting a member to a household waits for
      // a role transition on it to finish.
      //
      // That cost is accepted (both operations are rare, and admitting someone
      // mid-swap has no meaning worth preserving), but it is the kind of
      // interaction that is discovered in production if nobody writes it down.
      const fixture = await arrangeOwnerAndMember();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(transitionLock.text, [fixture.householdId]);

        await waiter.begin();
        const pending = waiter.issue<{ id: string }>(
          shareLock.text,
          [fixture.householdId],
          "the admission guard's share lock",
        );

        await expectBlocked(barrier, pending);
        await holder.commit();
        await expect(pending.result()).resolves.toHaveLength(1);

        await waiter.commit();
      });
    });
  });
});
