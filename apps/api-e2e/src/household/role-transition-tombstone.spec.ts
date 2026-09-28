import { SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectLockWaiter, withBarrier, type Barrier } from '../support/lock-barrier';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { SOFT_DELETE_HOUSEHOLD } from './lock-fixtures';

/**
 * #386's acceptance over HTTP: a role transition that passed every check in
 * front of its lock, racing a soft-delete that commits first.
 *
 * Each transition probes the household's existence before its transaction,
 * and that probe takes no lock. So a delete committing between the probe and
 * the lock used to leave the transition rewriting roles on a household the API
 * treats as gone, and a transfer recorded its audit row and webhook for it.
 * The lock now re-checks liveness, which is what these cases drive.
 *
 * The barrier holds a real soft-delete open. Every read in front of the lock is
 * a plain MVCC read, so it sees the household live and does not wait; the
 * request reaches its transaction and queues on the row. `expectLockWaiter`
 * proves it queued there rather than answering first, and the running
 * statement proves which lock it queued on. Then the delete commits, and the
 * request must come back 404 with the roster untouched.
 *
 * The SQL-level half, what the statement itself does after the delete
 * commits, is `owner-lock-serialization.spec.ts`.
 */
describe('role transitions racing a soft-delete (#386)', () => {
  const baseUrl = requireBaseUrl(process.env);

  /**
   * Generous for the reason `plugin-prerow-race.spec.ts` gives: the request
   * clears a session lookup and the route guards before it reaches the lock,
   * and a cold start is seconds-scale. A request that answers is reported at
   * once by `settledEarly`, so the long budget only costs time on a stuck run.
   */
  const REQUEST_REACHES_LOCK_MS = 20_000;

  /**
   * The internal event name `transferOwnership` emits, and so the `event`
   * column of the audit row it produces. Inlined rather than imported from
   * `@bge/household`, for the reason `household-wire.ts` gives: this suite is
   * black-box.
   */
  const OWNERSHIP_TRANSFERRED = 'household.ownership.transferred';

  /** How long an audit row may take to land after the response that caused it. */
  const AUDIT_ROW_LANDS_MS = 5_000;

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const membersPath = (householdId: string): string => `/api/households/${householdId}/members`;

  interface Arrangement {
    readonly householdId: string;
    readonly owner: SessionActor;
    readonly member: SessionActor;
    readonly memberId: string;
  }

  /** An owner and one plain member, which is all any of the four needs. */
  const arrange = async (): Promise<Arrangement> => {
    const owner = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Deleted while a transition waits',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });

    return { householdId: fixture.household.id, owner, member, memberId: fixture.members[0].member.id };
  };

  /**
   * Each transition, sent by an actor it would succeed for on a live household.
   * That is what makes the 404 mean the lock refused it: nothing else about the
   * request is wrong.
   */
  const TRANSITIONS: readonly { readonly name: string; readonly send: (a: Arrangement) => request.Test }[] = [
    {
      name: 'transfer of ownership',
      send: ({ householdId, owner, memberId }) =>
        request(baseUrl)
          .post(`${membersPath(householdId)}/${memberId}/transfer-ownership`)
          .set(owner.headers),
    },
    {
      name: 'role change',
      send: ({ householdId, owner, memberId }) =>
        request(baseUrl)
          .patch(`${membersPath(householdId)}/${memberId}/role`)
          .set(owner.headers)
          .send({ role: SystemRole.HouseholdAdmin }),
    },
    {
      name: 'removal',
      send: ({ householdId, owner, memberId }) =>
        request(baseUrl)
          .delete(`${membersPath(householdId)}/${memberId}`)
          .set(owner.headers),
    },
    {
      name: 'departure',
      send: ({ householdId, member }) =>
        request(baseUrl)
          .delete(`${membersPath(householdId)}/me`)
          .set(member.headers),
    },
  ];

  /** Every member and role, so "untouched" is a comparison rather than a count. */
  const roster = (householdId: string) =>
    db.client.householdMember.findMany({
      where: { householdId },
      select: { id: true, userId: true, role: { select: { role: { select: { name: true } } } } },
      orderBy: { id: 'asc' },
    });

  /** The barrier's own backends, which are never the request under test. */
  const barrierPids = (barrier: Barrier): number[] => [barrier.waiter.pid, barrier.observer.pid];

  /**
   * Fires a request that is expected to BLOCK, and keeps hold of it safely: the
   * pending response is pre-handled so an assertion failing before it is
   * awaited cannot surface as an unhandled rejection, and its outcome is
   * offered to `expectLockWaiter` for reporting. Same shape as the helper in
   * `plugin-prerow-race.spec.ts`.
   */
  const fire = (send: () => request.Test) => {
    let outcome: string | undefined;
    const settled = send().then(
      (response) => {
        outcome = `HTTP ${response.status}`;

        return response;
      },
      (error: unknown) => {
        outcome = `it failed: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      },
    );

    settled.catch(() => undefined);

    return { settled, settledEarly: () => outcome };
  };

  /**
   * Holds a soft-delete of the household open, sends the transition, waits for
   * it to queue on the role-transition lock, then commits the delete.
   */
  const raceBehindSoftDelete = async (arrangement: Arrangement, name: string, send: () => request.Test) =>
    withBarrier(async (barrier) => {
      const { holder } = barrier;

      await holder.begin();
      await expect(holder.query(SOFT_DELETE_HOUSEHOLD, [arrangement.householdId])).resolves.toHaveLength(1);

      // Deliberately not awaited: it is supposed to be stuck.
      const transition = fire(send);

      const waiter = await expectLockWaiter(barrier, {
        heldBy: holder.pid,
        description: `the ${name} request`,
        timeoutMs: REQUEST_REACHES_LOCK_MS,
        exclude: barrierPids(barrier),
        settledEarly: transition.settledEarly,
      });

      // Queued on the role-transition lock specifically, the statement whose
      // re-check this suite is about.
      expect(waiter.query).toContain('FOR NO KEY UPDATE');

      // Released before anything else is asked of the database: the request is
      // inside an interactive transaction on the default 5s budget, and an
      // expired budget surfaces as a 500 that reads as a lock failure.
      await holder.commit();

      return transition.settled;
    });

  it.each(TRANSITIONS)('answers 404 for a $name that queued behind the soft-delete', async ({ name, send }) => {
    const arrangement = await arrange();
    const before = await roster(arrangement.householdId);

    const response = await raceBehindSoftDelete(arrangement, name, () => send(arrangement));

    expect(response.status).toBe(404);

    const household = await db.client.household.findUniqueOrThrow({
      where: { id: arrangement.householdId },
      select: { deletedAt: true },
    });

    expect(household.deletedAt).not.toBeNull();
    await expect(roster(arrangement.householdId)).resolves.toEqual(before);
  });

  it('records no ownership transfer for the household it refused', async () => {
    // The event half of the acceptance. The absence is only worth asserting
    // once this harness is shown to record the event at all, so a transfer on
    // a second, live household runs AFTER the refused one, and its audit row
    // is awaited first. The refused request answered before the control was
    // sent, so any row it had caused would have been written by then too.
    const doomed = await arrange();
    const [transfer] = TRANSITIONS;

    const refused = await raceBehindSoftDelete(doomed, transfer.name, () => transfer.send(doomed));
    expect(refused.status).toBe(404);

    const control = await arrange();
    await transfer.send(control).expect(200);

    const auditRowsFor = (householdId: string): Promise<number> =>
      db.client.auditLog.count({ where: { event: OWNERSHIP_TRANSFERRED, subjectId: householdId } });

    const deadline = Date.now() + AUDIT_ROW_LANDS_MS;
    while ((await auditRowsFor(control.householdId)) === 0 && Date.now() < deadline) {
      await sleep(50);
    }

    await expect(auditRowsFor(control.householdId)).resolves.toBe(1);
    await expect(auditRowsFor(doomed.householdId)).resolves.toBe(0);
  });
});
