import { EventParticipationStatus } from '@bge/database';

/**
 * The `rsvpDate` an attendee holds with `status`, set at `at` (#1027).
 * `rsvpDate` is the date the attendee's current answer was set, so it is
 * null exactly when the status is Invited: an attendee still invited holds
 * no answer yet. The answer is usually the attendee's own RSVP, but a row
 * added or revived with an answer, by the host for example, is dated from
 * that add.
 */
export function rsvpDateFor(status: EventParticipationStatus, at: Date): Date | null {
  return status === EventParticipationStatus.Invited ? null : at;
}
