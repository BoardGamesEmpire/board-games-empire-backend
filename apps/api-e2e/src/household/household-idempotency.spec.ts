import { isPrismaUniqueConstraintError } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { constraintTargetNames, createEnvelope } from './household-wire';

/**
 * The wire payload for `POST /api/households`. Declared here rather than
 * imported from `@bge/household`'s `CreateHouseholdDto`: the suite is black-box,
 * importing the DTO would pull class-validator and `@bge/i18n` into the test
 * process, and several cases below deliberately send values a DTO-typed
 * parameter would forbid.
 */
interface CreateHouseholdPayload {
  readonly name: string;
  readonly description?: string;
  readonly language?: string;
  readonly clientRequestId?: string;
}

/**
 * #210's acceptance criterion, deferred from PR #253 to #257 because it is a
 * database-level assertion: the `(createdById, clientRequestId)` unique and the
 * P2002 recovery path ARE the mechanism, so no amount of coverage against a
 * mocked `DatabaseService` can show whether the constraint fires or whether the
 * error arrives in the shape the recovery path discriminates on.
 *
 * Every actor here is a plain `SystemRole.User` rather than the Owner sentinel.
 * The sentinel holds `manage:all`, which would make every request succeed for
 * reasons unrelated to idempotency — the cost is one extra signup per test,
 * since `actors.user()` absorbs the Owner seat first.
 */
describe('household create idempotency (#210 acceptance)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const HOUSEHOLDS_PATH = '/api/households';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const post = (actor: SessionActor, payload: CreateHouseholdPayload) =>
    request(baseUrl).post(HOUSEHOLDS_PATH).set(actor.headers).send(payload);

  /** Random, never sequential — see `prepareSignup`'s note on #268. */
  const freshKey = (): string => `e2e-key-${randomUUID()}`;

  const householdCountFor = (actor: SessionActor): Promise<number> =>
    db.client.household.count({ where: { createdById: actor.user.id } });

  describe('a repeat submission with the same key', () => {
    it('produces exactly one household, and both responses carry its id', async () => {
      const actor = await actors.user();
      const clientRequestId = freshKey();
      const payload: CreateHouseholdPayload = { name: 'Keyed household', clientRequestId };

      const first = await post(actor, payload).expect(201);
      const second = await post(actor, payload).expect(201);

      const original = createEnvelope(first, 'POST /api/households (first)');
      const replay = createEnvelope(second, 'POST /api/households (replay)');

      expect(replay.household.id).toBe(original.household.id);
      await expect(householdCountFor(actor)).resolves.toBe(1);

      // D-257-9: a replay is indistinguishable from a create on the wire. Both
      // are 201 (asserted above) and carry the same envelope, so a client
      // cannot infer that its retry was a retry — which is the whole point of
      // supplying a key.
      expect(replay.message).toBe(original.message);

      // The nested member create is inside the same implicit transaction as the
      // household insert, so a duplicate row here would mean the loser
      // partially committed.
      await expect(db.client.householdMember.count({ where: { householdId: original.household.id } })).resolves.toBe(1);
    });

    it('produces exactly one household when both submissions are in flight at once', async () => {
      // The case only a real database can show. Both requests traverse real
      // HTTP into the running server and race on the unique index; the loser
      // blocks until the winner commits, then recovers the committed row.
      // `maxWorkers: 1` constrains test-level parallelism, not request-level
      // concurrency within a test.
      //
      // Deliberately two requests, not a large burst: the `default` throttler
      // keys on handler plus IP, so a burst here lands in this endpoint's own
      // bucket alongside every other spec that posts a household — and a wide
      // one would be asserting the rate limiter rather than the constraint
      // (see API_THROTTLE_LIMIT, and #293 for why that pin now matters).
      const actor = await actors.user();
      const payload: CreateHouseholdPayload = { name: 'Concurrent household', clientRequestId: freshKey() };

      const [first, second] = await Promise.all([post(actor, payload), post(actor, payload)]);

      // Asserted rather than `.expect(201)`-chained so a 500 from a failed
      // discriminator reports its status instead of an unhandled rejection.
      expect([first.status, second.status]).toEqual([201, 201]);

      const winner = createEnvelope(first, 'POST /api/households (concurrent A)');
      const loser = createEnvelope(second, 'POST /api/households (concurrent B)');

      expect(loser.household.id).toBe(winner.household.id);
      await expect(householdCountFor(actor)).resolves.toBe(1);
    });

    it('ignores the repeat payload entirely — first writer wins', async () => {
      const actor = await actors.user();
      const clientRequestId = freshKey();

      const first = await post(actor, { name: 'Original name', description: 'original', clientRequestId }).expect(201);
      const second = await post(actor, { name: 'Divergent name', description: 'divergent', clientRequestId }).expect(
        201,
      );

      const original = createEnvelope(first, 'POST /api/households (original)');
      const replay = createEnvelope(second, 'POST /api/households (divergent replay)');

      expect(replay.household.id).toBe(original.household.id);
      expect(replay.household.name).toBe('Original name');
      expect(replay.household.description).toBe('original');

      // ...and the divergent payload did not reach the row either.
      const persisted = await db.client.household.findUniqueOrThrow({ where: { id: original.household.id } });
      expect(persisted.name).toBe('Original name');
      expect(persisted.description).toBe('original');
    });

    it('returns the tombstone when the original was since soft-deleted', async () => {
      // `recoverKeyedCreate` looks the key up WITHOUT a `deletedAt: null`
      // filter on purpose: the keyed create semantically succeeded, and that
      // row is its canonical outcome even after deletion. The alternative —
      // creating a second household — would silently defeat the key.
      const actor = await actors.user();
      const clientRequestId = freshKey();

      const created = createEnvelope(
        await post(actor, { name: 'Doomed household', clientRequestId }).expect(201),
        'POST /api/households',
      );

      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${created.household.id}`).set(actor.headers).expect(200);

      const replay = createEnvelope(
        await post(actor, { name: 'Doomed household', clientRequestId }).expect(201),
        'POST /api/households (post-delete replay)',
      );

      expect(replay.household.id).toBe(created.household.id);
      expect(replay.household.deletedAt).not.toBeNull();
      await expect(householdCountFor(actor)).resolves.toBe(1);
    });
  });

  describe('what does not replay', () => {
    it('treats distinct keys as distinct submissions, identical payload notwithstanding', async () => {
      const actor = await actors.user();
      const payload = { name: 'Same body' } as const;

      const first = createEnvelope(
        await post(actor, { ...payload, clientRequestId: freshKey() }).expect(201),
        'POST A',
      );
      const second = createEnvelope(
        await post(actor, { ...payload, clientRequestId: freshKey() }).expect(201),
        'POST B',
      );

      expect(second.household.id).not.toBe(first.household.id);
      await expect(householdCountFor(actor)).resolves.toBe(2);
    });

    it('creates a household per submission when no key is supplied', async () => {
      // NULLs are distinct under the composite unique, so keyless creates are
      // unaffected by it — the behaviour that existed before #210.
      const actor = await actors.user();

      const first = createEnvelope(await post(actor, { name: 'Keyless' }).expect(201), 'POST A');
      const second = createEnvelope(await post(actor, { name: 'Keyless' }).expect(201), 'POST B');

      expect(second.household.id).not.toBe(first.household.id);
      await expect(householdCountFor(actor)).resolves.toBe(2);
      expect(first.household.clientRequestId).toBeNull();
    });

    it('scopes keys per user, so the same key from two actors creates two households', async () => {
      // The unique is `(createdById, clientRequestId)`, not a global key space:
      // a shared client id scheme must not let one user's retry collide with
      // another's first submission.
      const [first, second] = [await actors.user(), await actors.user()];
      const clientRequestId = freshKey();

      const firstHousehold = createEnvelope(
        await post(first, { name: 'Mine', clientRequestId }).expect(201),
        'POST as first actor',
      );
      const secondHousehold = createEnvelope(
        await post(second, { name: 'Also mine', clientRequestId }).expect(201),
        'POST as second actor',
      );

      expect(secondHousehold.household.id).not.toBe(firstHousehold.household.id);
      await expect(householdCountFor(first)).resolves.toBe(1);
      await expect(householdCountFor(second)).resolves.toBe(1);
    });
  });

  describe('key validation', () => {
    it('rejects a blank key rather than silently dropping it', async () => {
      // Both cases are 400s from the DTO. Whitespace-only is the one
      // `@MinLength(1)` alone would have admitted: the `@Transform` trim runs
      // first, collapsing it to '' before length validation. Without the trim
      // it would reach the service, be normalized away, and cost the caller its
      // idempotency guarantee with a 201 that looks like success.
      const actor = await actors.user();

      await post(actor, { name: 'Blank key', clientRequestId: '' }).expect(400);
      await post(actor, { name: 'Blank key', clientRequestId: '   ' }).expect(400);

      await expect(householdCountFor(actor)).resolves.toBe(0);
    });

    it('collapses padding, so a retry differing only in whitespace replays', async () => {
      const actor = await actors.user();
      const clientRequestId = freshKey();

      const padded = createEnvelope(
        await post(actor, { name: 'Padded', clientRequestId: `  ${clientRequestId}  ` }).expect(201),
        'POST with padded key',
      );
      const bare = createEnvelope(
        await post(actor, { name: 'Padded', clientRequestId }).expect(201),
        'POST with bare key',
      );

      expect(bare.household.id).toBe(padded.household.id);
      expect(padded.household.clientRequestId).toBe(clientRequestId);
      await expect(householdCountFor(actor)).resolves.toBe(1);
    });

    it('measures the length cap after trimming', async () => {
      const actor = await actors.user();
      const atCap = 'k'.repeat(128);

      await post(actor, { name: 'At cap', clientRequestId: atCap }).expect(201);
      await post(actor, { name: 'Over cap', clientRequestId: `${atCap}k` }).expect(400);
      // 132 characters as submitted, 128 after the trim the DTO applies first.
      await post(actor, { name: 'Padded to cap', clientRequestId: `  ${'j'.repeat(128)}  ` }).expect(201);

      await expect(householdCountFor(actor)).resolves.toBe(2);
    });
  });

  describe('the P2002 the recovery path relies on', () => {
    it('raises a P2002 that carries no usable meta.target', async () => {
      // #257 D-257-2, and now deliberately NARROWED.
      //
      // This began as an assertion that `meta.target` carries the mapped
      // constraint name. It does not, and finding that out was the most valuable
      // thing this suite has done: `HouseholdService` discriminated replays on
      // `meta.target`, so it matched nothing, every keyed retry rethrew, and
      // #210's guarantee had inverted into a 500 on precisely the request it
      // exists to make safe. Every HTTP case above was failing for that reason.
      //
      // It then grew a second half asserting that the identity survives under
      // `meta.driverAdapterError`. That half has MOVED to
      // `apps/api-e2e/src/database/p2002-shape.spec.ts`, which pins it against
      // the constraint that actually reads it — the membership unique, from a
      // nested create inside a transaction (#298). Keeping a copy here would
      // duplicate a characterization of `@bge/database` inside a household
      // suite, and the two would drift.
      //
      // What remains is the property THIS suite depends on, and only that:
      //
      //   1. A duplicate keyed insert DOES raise a P2002. Load-bearing, because
      //      the household and feedback recovery paths key off the ROW but only
      //      look for the row once they see a unique violation.
      //   2. `meta.target` is empty. Characterization, so the assumption cannot
      //      rot silently — a populated target would be welcome, but resuming
      //      use of it must be a decision rather than a drift.
      //
      // Sanctioned plumbing under #255's revised D-6 ("verifying state no
      // endpoint exposes"), and representative because `createTestDatabase`
      // builds its client the way `DatabaseService` builds its own — explicit
      // `pg` Pool plus `PrismaPg`. If either side stops using the driver
      // adapter, this observes a shape the application does not.
      const actor = await actors.user();
      const clientRequestId = freshKey();

      await db.client.household.create({
        data: { name: 'Probe original', createdById: actor.user.id, clientRequestId },
      });

      let captured: unknown;
      try {
        await db.client.household.create({
          data: { name: 'Probe duplicate', createdById: actor.user.id, clientRequestId },
        });
      } catch (error) {
        captured = error;
      }

      // (1) The trigger the recovery path depends on.
      if (!isPrismaUniqueConstraintError(captured)) {
        throw new Error(
          `Expected a P2002 from the second insert on the same (createdById, clientRequestId), got: ` +
            `${captured instanceof Error ? `${captured.name}: ${captured.message}` : String(captured)}. ` +
            `If nothing threw, the composite unique is missing from the applied migration set.`,
        );
      }

      // (2) `meta.target` is empty.
      const names = constraintTargetNames(captured.meta?.['target']);

      if (names.length > 0) {
        throw new Error(
          `Prisma now reports a P2002 target: ${JSON.stringify(names)} (meta=${JSON.stringify(captured.meta)}). ` +
            `That is a change from what was measured on 2026-08-10, not a defect — but the household and feedback ` +
            `recovery paths no longer read it, so making it load-bearing again is a decision. The reader that DOES ` +
            `consult it is HouseholdMemberService (#298); see p2002-shape.spec.ts.`,
        );
      }

      expect(names).toEqual([]);
    });
  });
});
