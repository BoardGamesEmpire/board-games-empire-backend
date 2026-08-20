import { FeedbackCategory, FeedbackSeverity, isPrismaUniqueConstraintError } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { isolateFeedbackQueue } from './feedback-queue-isolation';
import { createFeedbackClient, freshFeedbackKey, reportPayload } from './feedback-request';
import { submitEnvelope } from './feedback-wire';

/** Mirrors `FEEDBACK_MAX_CLIENT_REQUEST_ID_LENGTH`; inlined per the black-box rule. */
const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

/**
 * #251's acceptance criterion, deferred to #262 because it is a database-level
 * assertion: the `(userId, clientRequestId)` unique and the P2002 recovery path
 * ARE the mechanism, so coverage against a mocked `DatabaseService` cannot show
 * whether the constraint fires or whether recovery finds the committed row.
 *
 * This suite exists because that recovery path was BROKEN on `master` and its
 * unit specs were green. `FeedbackService` discriminated replays on a
 * `meta.target` that `@prisma/client@7.8.0` + `PrismaPg` never populates, so
 * every keyed retry rethrew and #251's guarantee inverted into a 500 on exactly
 * the request it exists to make safe. It was fixed in PR #300 on the strength of
 * the household equivalent's e2e finding, not its own — these are the assertions
 * that would have caught it here.
 *
 * Every actor is a plain `SystemRole.User`, which carries
 * `create:feedback_report`. The Owner sentinel holds `manage:all` and would make
 * every request succeed for reasons unrelated to idempotency.
 *
 * THROTTLE BUDGET. The submit route replaces the app-wide IP tier with
 * its own 100/IP/hour, which `API_THROTTLE_LIMIT` does not raise, and the buckets
 * are in-process in a child that outlives the truncate sweep. Every POST in this
 * file counts against a ceiling shared with every other feedback spec in the run.
 * This file spends roughly 21 of it; `feedback-throttle.spec.ts` spends ~31.
 * Adding cases here is not free — see #343.
 */
describe('feedback submission idempotency (#251 acceptance)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { post } = createFeedbackClient(baseUrl);
  const freshKey = freshFeedbackKey;
  const report = reportPayload;

  let db: TestDatabase;
  let actors: Actors;

  // Every accepted submission here enqueues a delivery job. This file never
  // looks at the queue, but a job it leaves behind fails `harness.spec.ts`.
  isolateFeedbackQueue();

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const reportCountFor = (actor: SessionActor): Promise<number> =>
    db.client.feedbackReport.count({ where: { userId: actor.user.id } });

  describe('a repeat submission with the same key', () => {
    it('produces exactly one report, and both responses carry its id', async () => {
      const actor = await actors.user();
      const clientRequestId = freshKey();
      const payload = report({ clientRequestId });

      const first = await post(actor, payload).expect(201);
      const second = await post(actor, payload).expect(201);

      const original = submitEnvelope(first, 'POST /api/feedback/reports (first)');
      const replay = submitEnvelope(second, 'POST /api/feedback/reports (replay)');

      expect(replay.feedbackReport.id).toBe(original.feedbackReport.id);
      await expect(reportCountFor(actor)).resolves.toBe(1);
    });

    it('is indistinguishable from the original on the wire (#251)', async () => {
      // Both are 201 with the same envelope, so a client cannot infer that its
      // retry was a retry — which is the whole point of supplying a key, and
      // what makes the client's "any 2xx is success" contract hold. A replay
      // that returned 200, or a different message, would leak the distinction.
      const actor = await actors.user();
      const payload = report({ clientRequestId: freshKey() });

      const first = await post(actor, payload).expect(201);
      const second = await post(actor, payload).expect(201);

      const original = submitEnvelope(first, 'POST /api/feedback/reports (first)');
      const replay = submitEnvelope(second, 'POST /api/feedback/reports (replay)');

      expect(replay.message).toBe(original.message);
      // createdAt is the ORIGINAL row's timestamp, not the replay's clock: the
      // replay returns the persisted row rather than re-stamping it.
      expect(replay.feedbackReport.createdAt).toBe(original.feedbackReport.createdAt);
    });

    it('produces exactly one report when both submissions are in flight at once', async () => {
      // The case only a real database can show. Both requests traverse real HTTP
      // into the running server and race on the unique index; the loser blocks
      // until the winner commits, then recovers the committed row. `maxWorkers: 1`
      // constrains test-level parallelism, not request-level concurrency.
      //
      // Deliberately two requests, not a burst: a wide one would assert the rate
      // limiter rather than the constraint (see the throttle budget above).
      const actor = await actors.user();
      const payload = report({ clientRequestId: freshKey() });

      const [first, second] = await Promise.all([post(actor, payload), post(actor, payload)]);

      // Asserted rather than `.expect(201)`-chained so a 500 from a failed
      // recovery reports its status instead of an unhandled rejection.
      expect([first.status, second.status]).toEqual([201, 201]);

      const winner = submitEnvelope(first, 'POST /api/feedback/reports (concurrent A)');
      const loser = submitEnvelope(second, 'POST /api/feedback/reports (concurrent B)');

      expect(loser.feedbackReport.id).toBe(winner.feedbackReport.id);
      await expect(reportCountFor(actor)).resolves.toBe(1);
    });

    it('ignores the repeat payload entirely — first writer wins (#251)', async () => {
      const actor = await actors.user();
      const clientRequestId = freshKey();

      const first = await post(actor, report({ clientRequestId, message: 'Original body', title: 'Original' })).expect(
        201,
      );
      const second = await post(
        actor,
        report({ clientRequestId, message: 'Divergent body', title: 'Divergent', severity: FeedbackSeverity.Critical }),
      ).expect(201);

      const original = submitEnvelope(first, 'POST (original)');
      const replay = submitEnvelope(second, 'POST (divergent replay)');

      expect(replay.feedbackReport.id).toBe(original.feedbackReport.id);

      // Asserted as persisted state: the divergent body must not have been
      // written anywhere, which the receipt envelope cannot show.
      const stored = await db.client.feedbackReport.findUniqueOrThrow({ where: { id: original.feedbackReport.id } });

      expect(stored.message).toBe('Original body');
      expect(stored.title).toBe('Original');
      expect(stored.severity).toBe(FeedbackSeverity.Low);
      await expect(reportCountFor(actor)).resolves.toBe(1);
    });

    it('resolves a padded key to the same bucket as its trimmed form (#251)', async () => {
      // The DTO trims before validating, so padding cannot split one logical key
      // into two rows. Without the trim these would be two distinct keys and the
      // caller would silently lose idempotency across retries that differ only
      // in whitespace.
      const actor = await actors.user();
      const key = freshKey();

      const first = await post(actor, report({ clientRequestId: `  ${key}  ` })).expect(201);
      const second = await post(actor, report({ clientRequestId: key })).expect(201);

      expect(submitEnvelope(second, 'POST (trimmed)').feedbackReport.id).toBe(
        submitEnvelope(first, 'POST (padded)').feedbackReport.id,
      );
      await expect(reportCountFor(actor)).resolves.toBe(1);

      // Persisted in trimmed form, not as sent.
      const stored = await db.client.feedbackReport.findFirstOrThrow({ where: { userId: actor.user.id } });
      expect(stored.clientRequestId).toBe(key);
    });
  });

  describe('what does NOT collapse into one report', () => {
    it('treats different keys with an identical payload as two reports', async () => {
      const actor = await actors.user();
      const payload = report({ message: 'Same body, different keys' });

      await post(actor, { ...payload, clientRequestId: freshKey() }).expect(201);
      await post(actor, { ...payload, clientRequestId: freshKey() }).expect(201);

      // The key is the identity, not the body.
      await expect(reportCountFor(actor)).resolves.toBe(2);
    });

    it('treats keyless submissions as distinct, since NULLs are distinct', async () => {
      const actor = await actors.user();
      const payload = report();

      await post(actor, payload).expect(201);
      await post(actor, payload).expect(201);

      // Keyless behaviour is preserved: the composite unique does not collapse
      // NULL keys, so a client that supplies no key gets no idempotency.
      await expect(reportCountFor(actor)).resolves.toBe(2);
    });

    it('scopes keys per user — the same key from two actors is two reports', async () => {
      const [first, second] = [await actors.user(), await actors.user()];
      const clientRequestId = freshKey();
      const payload = report({ clientRequestId });

      await post(first, payload).expect(201);
      await post(second, payload).expect(201);

      // Per-user scope, so one client's key cannot collide with another's — and
      // cannot be used to probe for another user's reports.
      await expect(reportCountFor(first)).resolves.toBe(1);
      await expect(reportCountFor(second)).resolves.toBe(1);
    });
  });

  describe('clientRequestId validation', () => {
    // Status only, never message text: `I18nValidationExceptionFilter` runs with
    // `detailedErrors: false`, so asserting the message shape would couple these
    // specs to the filter's presentation rather than to the contract.
    it('rejects an empty key', async () => {
      const actor = await actors.user();
      await post(actor, report({ clientRequestId: '' })).expect(400);
      await expect(reportCountFor(actor)).resolves.toBe(0);
    });

    it('rejects a whitespace-only key rather than silently dropping it', async () => {
      // The case `@MinLength(1)` alone would let through: the DTO's `@Transform`
      // trims first, so '   ' collapses to '' and fails validation. Without the
      // trim it would reach the service, be normalized away, and cost the caller
      // its idempotency guarantee with a 201 that looks perfectly successful.
      const actor = await actors.user();
      await post(actor, report({ clientRequestId: '   ' })).expect(400);
      await expect(reportCountFor(actor)).resolves.toBe(0);
    });

    it('accepts a key at exactly the cap and rejects one past it', async () => {
      const actor = await actors.user();

      await post(actor, report({ clientRequestId: 'k'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH) })).expect(201);
      await post(actor, report({ clientRequestId: 'k'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH + 1) })).expect(400);
    });

    it('measures the cap after trimming, not before', async () => {
      // A key at the cap wrapped in padding is still at the cap.
      const actor = await actors.user();
      const key = 'p'.repeat(MAX_CLIENT_REQUEST_ID_LENGTH);

      await post(actor, report({ clientRequestId: `  ${key}  ` })).expect(201);
      await expect(reportCountFor(actor)).resolves.toBe(1);
    });
  });

  describe('the P2002 the recovery path depends on', () => {
    it('fires on a duplicate keyed insert', async () => {
      // Sanctioned plumbing under #255's revised D-6 ("verifying state no
      // endpoint exposes"), and representative because `createTestDatabase`
      // builds its client the way `DatabaseService` builds its own — explicit
      // `pg` Pool plus `PrismaPg`. If either side stops using the driver
      // adapter, this observes a shape the application does not.
      //
      // Scope: this asserts the TRIGGER and nothing about `meta`.
      // `recoverKeyedSubmit` keys replay off the presence of a row under the
      // composite key, so the error's shape is not load-bearing here. The one
      // place the P2002 payload shape is pinned is
      // `apps/api-e2e/src/database/p2002-shape.spec.ts`; a second probe here
      // would duplicate a `@bge/database` characterization inside a feedback
      // suite and the two would drift.
      //
      // Still worth asserting, because the recovery path only looks for the row
      // once it has seen a unique violation — no P2002, no replay, and the
      // duplicate insert surfaces to the client as a 500.
      const actor = await actors.user();
      const clientRequestId = freshKey();

      await db.client.feedbackReport.create({
        data: {
          userId: actor.user.id,
          clientRequestId,
          message: 'Probe original',
          category: FeedbackCategory.Bug,
          severity: FeedbackSeverity.Low,
        },
      });

      let captured: unknown;
      try {
        await db.client.feedbackReport.create({
          data: {
            userId: actor.user.id,
            clientRequestId,
            message: 'Probe duplicate',
            category: FeedbackCategory.Bug,
            severity: FeedbackSeverity.Low,
          },
        });
      } catch (error) {
        captured = error;
      }

      if (!isPrismaUniqueConstraintError(captured)) {
        throw new Error(
          `Expected a P2002 from the second insert on the same (userId, clientRequestId), got: ` +
            `${captured instanceof Error ? `${captured.name}: ${captured.message}` : String(captured)}. ` +
            `If nothing threw, the composite unique is missing from the applied migration set.`,
        );
      }

      expect(captured.code).toBe('P2002');
    });

    it('leaves the rethrow branch unreachable: one unique besides the primary key', async () => {
      // `recoverKeyedSubmit` warns and rethrows when a P2002 arrives with no row
      // under the key. `feedback_reports` carries exactly one unique index
      // besides its primary key, so that branch should not be reachable — which
      // is why it logs at `warn` rather than `debug`: it is the branch that
      // reinstates the 500-then-retry-forever loop #251 removed, and
      // `resolvePinoLevel` drops debug in production.
      //
      // Asserted against the live schema rather than the Prisma model, so an
      // index added by a future migration surfaces here as a prompt to revisit
      // that branch instead of silently making it reachable.
      // `pg_index.indisunique` with `indisprimary` excluded, rather than
      // `pg_indexes.indexdef LIKE '%UNIQUE%'` — a primary key's definition also
      // says UNIQUE, so the text filter counts the pkey and the assertion reads
      // as an extra index. And not `pg_constraint` either: Prisma renders
      // `@@unique(..., map:)` as a unique INDEX rather than a constraint, so
      // filtering `contype` finds nothing at all (the trap issue 298 hit).
      //
      // Bound to `db.schema`, NOT `current_schema()`. `@prisma/adapter-pg`
      // reports the schema to the query engine but never issues a
      // `SET search_path`, so raw SQL runs against the connection default —
      // `public`. Under the documented escape hatch
      // (`BGE_E2E_DATABASE_URL=...?schema=e2e`) the tables are in `e2e` and
      // `current_schema()` would return `public`, so this query would come back
      // empty and report a missing constraint that is actually present. This is
      // the same reason `resetDatabase` binds the schema explicitly.
      const indexes = await db.client.$queryRaw<{ indexname: string }[]>`
        SELECT cls.relname AS indexname
        FROM pg_index idx
        JOIN pg_class cls ON cls.oid = idx.indexrelid
        JOIN pg_class tbl ON tbl.oid = idx.indrelid
        JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
        WHERE ns.nspname = ${db.schema}
          AND tbl.relname = 'feedback_reports'
          AND idx.indisunique
          AND NOT idx.indisprimary
      `;

      expect(indexes.map((row) => row.indexname).sort()).toEqual(['feedback_report_user_client_request_id_unique']);
    });
  });
});
