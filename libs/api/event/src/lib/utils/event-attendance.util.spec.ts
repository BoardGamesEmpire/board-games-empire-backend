import { EventParticipationStatus, Prisma } from '@bge/database';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import {
  EVENT_ATTENDANCE_SELECT,
  readEventAttendance,
  toEventAttendance,
  withEventAttendance,
  type EventAttendance,
  type EventAttendanceRow,
} from './event-attendance.util';

const RSVP_DATE = new Date('2026-11-01T12:00:00Z');

const attendanceRow = (overrides: Partial<EventAttendanceRow> = {}): EventAttendanceRow => ({
  id: 'a1',
  eventId: 'e1',
  status: EventParticipationStatus.Attending,
  rsvpDate: RSVP_DATE,
  role: { role: { name: 'EventHost' } },
  ...overrides,
});

describe('toEventAttendance (#867)', () => {
  it("maps an attendee row to the acting user's attendance, with the role by name", () => {
    expect(toEventAttendance(attendanceRow())).toEqual({
      attendeeId: 'a1',
      status: EventParticipationStatus.Attending,
      role: 'EventHost',
      rsvpDate: RSVP_DATE,
    });
  });

  it('gives a null role for an attendee with no role row', () => {
    expect(toEventAttendance(attendanceRow({ role: null })).role).toBeNull();
  });
});

describe('readEventAttendance (#867)', () => {
  let db: MockDatabaseService;

  const tx = () => db as unknown as Prisma.TransactionClient;
  const OWN_WHERE = { id: 'sentinel-where' } satisfies Prisma.EventAttendeeWhereInput;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.eventAttendee.findMany.mockResolvedValue([]);
  });

  it('reads under the where it is given, and keys the rows by event', async () => {
    const build = jest.fn().mockReturnValue(OWN_WHERE);
    const rowOne = attendanceRow({ id: 'a1', eventId: 'e1' });
    const rowTwo = attendanceRow({ id: 'a2', eventId: 'e2', status: EventParticipationStatus.Maybe });
    db.eventAttendee.findMany.mockResolvedValue([rowOne, rowTwo] as never);

    const attendance = await readEventAttendance(tx(), ['e1', 'e2', 'e3'], build);

    expect(build).toHaveBeenCalledWith(['e1', 'e2', 'e3']);
    expect(db.eventAttendee.findMany).toHaveBeenCalledWith({ where: OWN_WHERE, select: EVENT_ATTENDANCE_SELECT });
    expect(attendance.get('e1')?.attendeeId).toBe('a1');
    expect(attendance.get('e2')?.status).toBe(EventParticipationStatus.Maybe);
    expect(attendance.has('e3')).toBe(false);
  });

  it('makes no read for no events', async () => {
    const attendance = await readEventAttendance(tx(), [], () => OWN_WHERE);

    expect(attendance.size).toBe(0);
    expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
  });

  // `EventAttendee.userId` is nullable, so a where built on `userId: null` would
  // match the rows of attendees with no account. An actor with no user has no
  // row to read.
  it('makes no read for an actor with no user', async () => {
    const attendance = await readEventAttendance(tx(), ['e1'], null);

    expect(attendance.size).toBe(0);
    expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
  });
});

describe('withEventAttendance (#867)', () => {
  const attendance: EventAttendance = {
    attendeeId: 'a2',
    status: EventParticipationStatus.Invited,
    role: 'EventParticipant',
    rsvpDate: null,
  };

  it('gives each row its own attendance, and null where it has none, keeping order and fields', () => {
    const rows = [
      { id: 'e1', title: 'First' },
      { id: 'e2', title: 'Second' },
    ];

    expect(withEventAttendance(rows, new Map([['e2', attendance]]))).toEqual([
      { id: 'e1', title: 'First', attendance: null },
      { id: 'e2', title: 'Second', attendance },
    ]);
  });
});
