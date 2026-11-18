import type { PrismaClient } from '@bge/database';
import type { AuthenticatedActor } from '@bge/testing-e2e';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { createEventClient, EVENTS_PATH } from './event-request';

/** How long the audit listener may take to write its row after the request has answered. */
const AUDIT_ROW_LANDS_MS = 5_000;

/** How many audit rows name `actor` as the one who acted. */
const auditRowsBy = (prisma: PrismaClient, actor: AuthenticatedActor): Promise<number> =>
  prisma.auditLog.count({ where: { actorUserId: actor.user.id } });

/**
 * Counts the audit rows `actor` causes while `act` runs, none of them before
 * it (#1065).
 *
 * The audit listener writes after the request has answered, so a row's
 * absence means nothing until something shows the listener has caught up. A
 * second event of the actor's is edited before and after `act`, and each edit
 * records exactly one row, awaited before going on. A row `act` caused was
 * emitted a full request before the second edit's, so it has landed by then.
 * The second edit's own row is left out of the count.
 */
export async function auditRowsDuring<T>(
  baseUrl: string,
  prisma: PrismaClient,
  actor: AuthenticatedActor,
  act: () => Promise<T>,
): Promise<{ auditRows: number; result: T }> {
  const sentinelId = await createEventClient(baseUrl).createdEventId(actor);
  let edits = 0;

  const editSentinel = async () => {
    edits += 1;
    await request(baseUrl)
      .patch(`${EVENTS_PATH}/${sentinelId}`)
      .set(actor.headers)
      .send({ title: `audit sentinel edit ${edits}` })
      .expect(200);

    const recorded = () => prisma.auditLog.count({ where: { subjectId: sentinelId, action: 'update' } });
    const deadline = Date.now() + AUDIT_ROW_LANDS_MS;
    while ((await recorded()) < edits && Date.now() < deadline) {
      await sleep(50);
    }

    if ((await recorded()) !== edits) {
      throw new Error(`the audit sentinel's edit ${edits} recorded no row within ${AUDIT_ROW_LANDS_MS}ms`);
    }
  };

  await editSentinel();
  const before = await auditRowsBy(prisma, actor);

  const result = await act();

  await editSentinel();

  return { auditRows: (await auditRowsBy(prisma, actor)) - before - 1, result };
}
