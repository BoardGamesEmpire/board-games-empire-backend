import { FeedbackCategory, FeedbackSeverity, ResourceType } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { isolateFeedbackQueue } from './feedback-queue-isolation';
import { createFeedbackClient, freshFeedbackKey, reportPayload } from './feedback-request';
import { submitEnvelope } from './feedback-wire';

/** Mirrors `FEEDBACK_CREATE_PERMISSION_SLUG`; inlined per the black-box rule. */
const FEEDBACK_CREATE_PERMISSION_SLUG = 'create:feedback_report';

/**
 * A feedback ban must not be bypassable by supplying an idempotency key.
 *
 * The mechanism is a `UserPermission` row inverting `create:feedback_report`, so
 * the denial happens in `PoliciesGuard` — ahead of `FeedbackService` and
 * therefore ahead of the replay short-circuit. That ordering is the whole
 * property under test: if the guard ran after the service, a banned user could
 * keep re-submitting a key minted before the ban and receive 201s.
 *
 * ORDERING IS LOAD-BEARING HERE (#272). The ability graph is cached per user and
 * populates lazily on the first policy-guarded request, and the test process
 * cannot evict it. So the ban row is arranged BEFORE the actor's first such
 * request in every test below. This is the convention #256 documented and #257
 * pinned as a characterization test; a ban arranged after a successful
 * submission would be masked by the cache and this file would assert nothing.
 *
 * That constraint is also why the "replay is not a bypass" case arranges its
 * ORIGINAL report directly in the database rather than over HTTP: submitting it
 * would populate the cache pre-ban. What matters for that case is that a row
 * exists under the key — how it got there is not part of the contract being
 * asserted.
 */
describe('feedback submission authorization', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { post, postAnonymous } = createFeedbackClient(baseUrl);
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

  /**
   * Arranges the ban the way `FeedbackService.banUser` does — an inverted
   * `UserPermission` on `create:feedback_report`, resource-wide. Arranged
   * directly because banning has no HTTP surface yet: it is service-only, so
   * there is no product path to drive here.
   */
  async function banFeedback(actor: SessionActor, bannedBy: SessionActor): Promise<void> {
    const permission = await db.client.permission.findFirstOrThrow({
      where: { slug: FEEDBACK_CREATE_PERMISSION_SLUG },
      select: { id: true },
    });

    await db.client.userPermission.create({
      data: {
        userId: actor.user.id,
        permissionId: permission.id,
        resourceType: ResourceType.FeedbackReport,
        resourceId: null,
        inverted: true,
        grantedById: bannedBy.user.id,
      },
    });
  }

  it('denies a fresh submission from a banned user', async () => {
    const banner = await actors.user();
    const banned = await actors.user();
    await banFeedback(banned, banner);

    await post(banned, report({ clientRequestId: freshKey() })).expect(403);

    await expect(db.client.feedbackReport.count({ where: { userId: banned.user.id } })).resolves.toBe(0);
  });

  it('denies a keyed replay from a banned user — a key is not a bypass', async () => {
    const banner = await actors.user();
    const banned = await actors.user();
    const clientRequestId = freshKey();

    // The original, arranged directly so the ban lands before this actor's first
    // policy-guarded request (see the ordering note above).
    const original = await db.client.feedbackReport.create({
      data: {
        userId: banned.user.id,
        clientRequestId,
        message: 'Submitted before the ban',
        category: FeedbackCategory.Bug,
        severity: FeedbackSeverity.Low,
      },
      select: { id: true },
    });

    await banFeedback(banned, banner);

    // A replay of a key that WOULD have resolved to the existing report. The
    // guard denies before the service can short-circuit, so the caller cannot
    // use a pre-ban key to keep receiving 201s.
    await post(banned, report({ clientRequestId })).expect(403);

    // And the original is untouched — the denial is not a delete.
    await expect(db.client.feedbackReport.count({ where: { userId: banned.user.id } })).resolves.toBe(1);
    await expect(
      db.client.feedbackReport.findUniqueOrThrow({ where: { id: original.id }, select: { message: true } }),
    ).resolves.toEqual({ message: 'Submitted before the ban' });
  });

  it('bans one user without denying another', async () => {
    // The control, and it carries its own weight: a mistake in `banFeedback`
    // that denied EVERYONE — a resource-wide inversion applied globally rather
    // than per user, or a seed regression dropping `create:feedback_report` from
    // the base role — would leave both assertions above green and meaningless.
    //
    // Asserted on the bystander's own persisted row. An earlier version also
    // checked that the banned actor had no reports, which cannot fail: that
    // actor never submits here, so the count is 0 whatever the ban did.
    const banner = await actors.user();
    const banned = await actors.user();
    const bystander = await actors.user();
    await banFeedback(banned, banner);

    const response = await post(bystander, report({ clientRequestId: freshKey() })).expect(201);
    const { feedbackReport } = submitEnvelope(response, 'POST /api/feedback/reports');

    await expect(
      db.client.feedbackReport.findUniqueOrThrow({ where: { id: feedbackReport.id }, select: { userId: true } }),
    ).resolves.toEqual({ userId: bystander.user.id });
  });

  it('rejects an unauthenticated submission', async () => {
    await postAnonymous(report()).expect(401);
  });
});
