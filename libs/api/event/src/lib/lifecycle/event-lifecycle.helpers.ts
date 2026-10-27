import { Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { BadRequestException } from '@nestjs/common';

/**
 * Refuses a write that would add or confirm a date on a cancelled event
 * (#795). A cancelled event's dates are all cancelled or declined, and a new
 * Confirmed one would sit under an event called off.
 *
 * It reads the event's cancel `FOR SHARE`, which conflicts with the
 * `FOR NO KEY UPDATE` a cancel holds on the same row, so the two take turns.
 * A date write that comes second sees the cancel and answers 400. One that
 * comes first commits its date before the cancel reads the dates, and the
 * cancel's update of Confirmed dates catches it. Run it in the write's own
 * transaction, before the write.
 *
 * A missing event is left to the write that calls this, which answers it
 * with its own 404.
 */
export async function assertEventNotCancelled(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
  const [event] = await tx.$queryRaw<{ cancelledAt: Date | null }[]>(
    Prisma.sql`SELECT cancelled_at AS "cancelledAt" FROM events WHERE id = ${eventId} FOR SHARE`,
  );

  if (event && event.cancelledAt !== null) {
    throw new BadRequestException(t('errors.event.cancelled'));
  }
}
