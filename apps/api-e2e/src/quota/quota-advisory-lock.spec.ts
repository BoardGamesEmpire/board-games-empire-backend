import { createHash, randomUUID } from 'node:crypto';
import { expectBlocked, expectNotBlocked, withBarrier } from '../support/lock-barrier';
import { bindTemplate, readShippedSource, readShippedSql, readShippedValue } from '../support/shipped-sql';

/**
 * `QuotaService.consume`'s advisory lock (#98), the fourth site with the same
 * evidence gap and, until D-360-4, no owner: its unit spec asserts
 * `$executeRaw` was called once with the right key and stops there.
 *
 * The lock is what makes `consume()` atomic. Without it the check and the write
 * are a TOCTOU pair — two requests both read usage below the cap, both write,
 * and the cap is breached by exactly the amount nobody was watching. Everything
 * that claim rests on is Postgres lock semantics, executed here for the first
 * time.
 *
 * This suite touches no `quotas` rows on purpose. An advisory lock is keyed on
 * a number, not on data, so the mechanics are visible with no fixture at all —
 * and a fixture would only suggest the rows were part of what serializes.
 */
describe('quota advisory lock (pg_advisory_xact_lock)', () => {
  const QUOTA_SERVICE = 'libs/common/quota/src/lib/quota.service.ts';

  /**
   * The statement `consume()` ships. No `after` anchor: the file holds exactly
   * one raw statement, and the extractor refuses loudly if it grows a second.
   */
  const lockStatement = readShippedSql(QUOTA_SERVICE, ['key'], { matching: /pg_advisory_xact_lock/ });

  /** The string the key is hashed from, lifted rather than retyped (D-360-1). */
  const keyFormat = readShippedValue(QUOTA_SERVICE, ['resource', 'scope', 'scopeId'], {
    after: 'private advisoryLockKey',
  });

  /**
   * The rest of `advisoryLockKey`: sha1, first eight bytes, big-endian, which
   * is the int8 keyspace `pg_advisory_xact_lock(bigint)` requires.
   *
   * Recomputed here rather than lifted, because it is ordinary TypeScript and
   * not a template. {@link pinsTheDigestRecipe} is what keeps the recomputation
   * honest — without it a changed recipe would leave both sides of every
   * barrier below agreeing on a key production no longer takes, blocking
   * perfectly and proving nothing.
   */
  const advisoryKey = (resource: string, scope: string, scopeId: string): string =>
    createHash('sha1')
      .update(bindTemplate(keyFormat, [resource, scope, scopeId]))
      .digest()
      .readBigInt64BE(0)
      .toString();

  // Literals rather than imports: the suite is black-box and never loads
  // application code. `household_member_count` and `Household` are real values
  // from the resource taxonomy and the `QuotaScope` enum.
  const RESOURCE = 'household_member_count';
  const SCOPE = 'Household';

  it('pins the digest recipe the key derivation depends on', () => {
    // Named in the doc above as the guard on every recomputed key here.
    const source = readShippedSource(QUOTA_SERVICE);

    expect(source).toMatch(/createHash\('sha1'\)[\s\S]{0,160}readBigInt64BE\(0\)/);
  });

  it('executes the shipped statement against a real backend', async () => {
    // The cheap half: the statement runs, and the key it binds is accepted as
    // the `bigint` the function signature demands. A key that overflowed int8
    // — the failure the `readBigInt64BE` slice exists to prevent — fails here.
    await withBarrier(async ({ holder }) => {
      await holder.begin();

      await expect(
        holder.query(lockStatement.text, [advisoryKey(RESOURCE, SCOPE, randomUUID())]),
      ).resolves.toHaveLength(1);

      await holder.commit();
    });
  });

  it('blocks a second consume of the same resource, scope and scope id', async () => {
    // The property the TOCTOU fix rests on.
    const key = advisoryKey(RESOURCE, SCOPE, randomUUID());

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(lockStatement.text, [key]);

      await waiter.begin();
      const pending = waiter.issue(lockStatement.text, [key], 'the second consume');

      await expectBlocked(barrier, pending);

      await holder.commit();

      await expect(pending.result()).resolves.toHaveLength(1);
      await waiter.commit();
    });
  });

  it('does not serialize a different scope id', async () => {
    // The control against over-serialization: one household's consumption must
    // not queue behind another's. A key derived from the resource alone would
    // pass the case above and funnel every household through one lock.
    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(lockStatement.text, [advisoryKey(RESOURCE, SCOPE, randomUUID())]);

      await waiter.begin();
      const pending = waiter.issue(
        lockStatement.text,
        [advisoryKey(RESOURCE, SCOPE, randomUUID())],
        "another household's consume",
      );

      await expectNotBlocked(barrier, pending);

      await waiter.commit();
      await holder.commit();
    });
  });

  it('releases the key on ROLLBACK, not only on COMMIT', async () => {
    // A `consume()` that throws — an over-cap refusal is the common case — must
    // free the key with its transaction. The session-scoped variant would
    // strand it for the life of a pooled connection, and every later request
    // borrowing that connection would deadlock against a caller long gone.
    const key = advisoryKey(RESOURCE, SCOPE, randomUUID());

    await withBarrier(async (barrier) => {
      const { holder, waiter } = barrier;

      await holder.begin();
      await holder.query(lockStatement.text, [key]);

      await waiter.begin();
      const pending = waiter.issue(lockStatement.text, [key], 'the consume behind a refused one');

      await expectBlocked(barrier, pending);

      await holder.rollback();

      await expect(pending.result()).resolves.toHaveLength(1);
      await waiter.commit();
    });
  });

  /**
   * `consume()` sorts its keys before taking them, because one call can hold
   * several — an instance row and a type-level default, across scopes. The sort
   * is the no-deadlock argument for two calls whose key sets overlap, and it is
   * one line with no test.
   */
  describe('the sorted acquisition order', () => {
    const twoKeys = (): [string, string] => {
      const keys = [advisoryKey(RESOURCE, SCOPE, randomUUID()), advisoryKey(RESOURCE, SCOPE, randomUUID())];

      // The comparator `consume()` uses, on the same values.
      keys.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));

      return [keys[0] as string, keys[1] as string];
    };

    it('lets two overlapping consumes queue rather than deadlock', async () => {
      const [first, second] = twoKeys();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(lockStatement.text, [first]);
        await holder.query(lockStatement.text, [second]);

        await waiter.begin();
        const pending = waiter.issue(lockStatement.text, [first], 'the overlapping consume');

        await expectBlocked(barrier, pending);

        await holder.commit();

        await expect(pending.result()).resolves.toHaveLength(1);
        await waiter.query(lockStatement.text, [second]);
        await waiter.commit();
      });
    });

    it('deadlocks when the same two keys are taken in opposite orders — which is what the sort prevents', async () => {
      // The control that gives the sort its meaning. Postgres resolves the
      // cycle by aborting a participant, so the unsorted version of this code
      // would surface as an intermittent 500 on a write nobody could reproduce.
      const [first, second] = twoKeys();

      await withBarrier(async (barrier) => {
        const { holder, waiter } = barrier;

        await holder.begin();
        await holder.query(lockStatement.text, [first]);

        await waiter.begin();
        await waiter.query(lockStatement.text, [second]);

        // Each now wants what the other holds.
        const waiterPending = waiter.issue(lockStatement.text, [first], 'the reversed consume');
        await expectBlocked(barrier, waiterPending);

        const holderPending = holder.issue(lockStatement.text, [second], 'the sorted consume');

        const outcomes = await Promise.allSettled([waiterPending.result(), holderPending.result()]);
        const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: '40P01' });
      });
    });
  });
});
