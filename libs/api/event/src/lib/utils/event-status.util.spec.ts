import { EventStatus, OccurrenceStatus } from '@bge/database';
import { deriveEventStatus, withEventStatus, type EventStatusDate } from './event-status.util';

describe('deriveEventStatus', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');
  const live = { cancelledAt: null, archivedAt: null };

  const hoursFromNow = (hours: number) => new Date(now.getTime() + hours * 60 * 60 * 1000);

  const confirmed = (startDate: Date | null, endDate: Date | null = null): EventStatusDate => ({
    status: OccurrenceStatus.Confirmed,
    startDate,
    endDate,
  });

  it('reads Archived when archivedAt is set, ahead of a cancel (#795)', () => {
    const event = { cancelledAt: hoursFromNow(-48), archivedAt: hoursFromNow(-24) };

    expect(deriveEventStatus(event, [confirmed(hoursFromNow(24))], now)).toBe(EventStatus.Archived);
  });

  it('reads Cancelled when cancelledAt is set, whatever the dates say (#795)', () => {
    const event = { cancelledAt: hoursFromNow(-1), archivedAt: null };

    expect(deriveEventStatus(event, [confirmed(hoursFromNow(-2), hoursFromNow(2))], now)).toBe(EventStatus.Cancelled);
  });

  it.each<[string, EventStatusDate[]]>([
    ['no dates', []],
    ['only proposed dates', [{ status: OccurrenceStatus.Proposed, startDate: hoursFromNow(24), endDate: null }]],
    ['a confirmed date with no start', [confirmed(null)]],
    [
      'only cancelled and declined dates',
      [
        { status: OccurrenceStatus.Cancelled, startDate: hoursFromNow(-2), endDate: hoursFromNow(2) },
        { status: OccurrenceStatus.Declined, startDate: hoursFromNow(24), endDate: null },
      ],
    ],
  ])('reads Planning with %s: no confirmed date with a start counts (#795)', (_, dates) => {
    expect(deriveEventStatus(live, dates, now)).toBe(EventStatus.Planning);
  });

  it('reads Scheduled before its earliest confirmed start (#795)', () => {
    expect(deriveEventStatus(live, [confirmed(hoursFromNow(1), hoursFromNow(4))], now)).toBe(EventStatus.Scheduled);
  });

  it('reads Ongoing between its start and its end (#795)', () => {
    expect(deriveEventStatus(live, [confirmed(hoursFromNow(-1), hoursFromNow(1))], now)).toBe(EventStatus.Ongoing);
  });

  // A multi-day event spans its days: between day 1's end and day 2's start it
  // is still on, not Scheduled again.
  it('stays Ongoing between the days of a multi-day event (#795)', () => {
    const dates = [confirmed(hoursFromNow(-30), hoursFromNow(-24)), confirmed(hoursFromNow(18), hoursFromNow(24))];

    expect(deriveEventStatus(live, dates, now)).toBe(EventStatus.Ongoing);
  });

  it('reads Completed once every confirmed date has ended (#795)', () => {
    const dates = [confirmed(hoursFromNow(-30), hoursFromNow(-24)), confirmed(hoursFromNow(-6), hoursFromNow(-2))];

    expect(deriveEventStatus(live, dates, now)).toBe(EventStatus.Completed);
  });

  // A date with no end ends when it starts, so the moment it starts it is over.
  it('reads Completed for a lone date with no end that starts now (#795)', () => {
    expect(deriveEventStatus(live, [confirmed(now)], now)).toBe(EventStatus.Completed);
  });

  // An end before its start is clamped up to the start rather than trusted.
  it('reads Scheduled for a future date whose end is before its start (#795)', () => {
    expect(deriveEventStatus(live, [confirmed(hoursFromNow(4), hoursFromNow(-4))], now)).toBe(EventStatus.Scheduled);
  });

  it('ignores a cancelled date when finding the window (#795)', () => {
    const dates = [
      confirmed(hoursFromNow(24), hoursFromNow(26)),
      { status: OccurrenceStatus.Cancelled, startDate: hoursFromNow(-2), endDate: hoursFromNow(2) },
    ];

    expect(deriveEventStatus(live, dates, now)).toBe(EventStatus.Scheduled);
  });
});

describe('withEventStatus', () => {
  it('returns the event with the status worked out from its dates, leaving its fields as they were (#795)', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const event = { id: 'event-1', title: 'Game night', cancelledAt: null, archivedAt: null };

    expect(
      withEventStatus(
        event,
        [{ status: OccurrenceStatus.Confirmed, startDate: new Date('2026-06-16T00:00:00.000Z'), endDate: null }],
        now,
      ),
    ).toEqual({ ...event, status: EventStatus.Scheduled });
  });
});
