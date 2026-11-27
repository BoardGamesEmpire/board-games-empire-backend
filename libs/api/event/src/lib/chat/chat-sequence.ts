import type { Prisma } from '@bge/database';

/**
 * The next number in an event's event chat sequence (#1543): 1 for the event's
 * first message, and one past the last number handed out after that. Run it in
 * the send's own transaction, just before the message is written with the
 * number it returns.
 *
 * One upsert on the event's counter row does both cases. The first send
 * inserts the row at 1. A second first send racing it waits on the inserted
 * key, then takes the update arm and gets 2 instead of a unique violation.
 *
 * The update takes the counter row's lock and holds it until the transaction
 * ends, so two sends to one event take turns: the second waits until the
 * first commits, then reads its number. Commit order is therefore sequence
 * order, and a reader catching up by "everything after n" never skips a
 * number that commits later.
 *
 * A send that rolls back takes its increment with it, so the next send gets
 * the same number and the sequence keeps no gap. There is no backfill: a new
 * event has no counter row, and its first send inserts one and gets 1.
 */
export async function nextChatSequence(tx: Prisma.TransactionClient, eventId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ last_sequence: number }[]>`
    INSERT INTO event_chat_counters (event_id, last_sequence) VALUES (${eventId}, 1)
    ON CONFLICT (event_id) DO UPDATE SET last_sequence = event_chat_counters.last_sequence + 1
    RETURNING last_sequence
  `;

  if (row === undefined) {
    throw new Error(
      `Expected the event chat counter upsert for event ${eventId} to return its last_sequence row, but it returned none`,
    );
  }

  return row.last_sequence;
}
