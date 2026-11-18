import type { DatabaseService } from '@bge/database';
import { Action, ResourceType } from '@bge/database';
import type { ScopeComposer } from '@bge/permissions';
import type { MockDatabaseService } from '@bge/testing';
import { createMockDatabaseService } from '@bge/testing';
import { ATTENDEE_SUMMARY_SELECT, readableAttendees } from './attendee-summary';

const CEILING = { id: { in: ['a', 'b'] }, AND: [{ id: 'sentinel-condition' }] };

describe('readableAttendees (#1213)', () => {
  let db: MockDatabaseService;
  let compose: jest.Mock;

  const read = (ids: Iterable<string>) =>
    readableAttendees(db as unknown as DatabaseService, { compose } as unknown as ScopeComposer, ids);

  beforeEach(() => {
    db = createMockDatabaseService();
    compose = jest.fn().mockReturnValue(CEILING);
    db.eventAttendee.findMany.mockResolvedValue([]);
  });

  afterEach(() => jest.clearAllMocks());

  // In a nested select, a key holding only read on lineup games would see the
  // names and avatars it can't read on the attendee routes (#404, #559).
  it('reads the attendees in one query under the attendee read ceiling, ids deduplicated (#1213)', async () => {
    await read(['a', 'b', 'a']);

    expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, { id: { in: ['a', 'b'] } });
    expect(db.eventAttendee.findMany).toHaveBeenCalledTimes(1);
    expect(db.eventAttendee.findMany).toHaveBeenCalledWith({ where: CEILING, select: ATTENDEE_SUMMARY_SELECT });
  });

  it('keys the readable attendees by id (#1213)', async () => {
    const summary = { id: 'a', status: 'attending', guestName: null, user: null };
    db.eventAttendee.findMany.mockResolvedValue([summary] as never);

    const attendees = await read(['a', 'b']);

    expect([...attendees.keys()]).toEqual(['a']);
    expect(attendees.get('a')).toBe(summary);
  });

  it('reads nothing for no ids (#1213)', async () => {
    const attendees = await read([]);

    expect(db.eventAttendee.findMany).not.toHaveBeenCalled();
    expect(attendees.size).toBe(0);
  });

  // The where is the composed ceiling and nothing beside it: a `removedAt` or
  // status filter added to it would stop naming one who left.
  it('does not filter removed attendees, so one who left is still named (#1213)', async () => {
    await read(['a']);

    expect(compose).toHaveBeenCalledWith(ResourceType.EventAttendee, Action.read, { id: { in: ['a'] } });
    expect(db.eventAttendee.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: CEILING }));
  });
});
