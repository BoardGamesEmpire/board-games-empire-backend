import { OccurrenceStatus, type Prisma } from '@bge/database';
import { countLiveDates, LIVE_DATE_STATUSES } from './live-dates.util';

describe('countLiveDates (#796)', () => {
  it('counts the event dates that are proposed or confirmed', async () => {
    const count = jest.fn().mockResolvedValue(2);
    const tx = { eventOccurrence: { count } } as unknown as Prisma.TransactionClient;

    await expect(countLiveDates(tx, 'event-1')).resolves.toBe(2);

    expect(count).toHaveBeenCalledWith({
      where: { eventId: 'event-1', status: { in: LIVE_DATE_STATUSES } },
    });
    expect(LIVE_DATE_STATUSES).toEqual([OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed]);
  });
});
