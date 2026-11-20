import { EventParticipationStatus } from '@bge/database';
import { rsvpDateFor } from './rsvp-date.util';

describe('rsvpDateFor', () => {
  const at = new Date('2026-11-19T12:00:00.000Z');

  it.each([
    [EventParticipationStatus.Invited, null],
    [EventParticipationStatus.Attending, at],
    [EventParticipationStatus.Maybe, at],
    [EventParticipationStatus.NotAttending, at],
  ])('dates every answer and leaves Invited undated (#1027): %s', (status, expected) => {
    expect(rsvpDateFor(status, at)).toBe(expected);
  });
});
