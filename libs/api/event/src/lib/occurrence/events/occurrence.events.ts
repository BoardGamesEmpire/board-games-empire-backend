import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type EventAvailabilityVote, type EventOccurrence } from '@bge/database';
import { OccurrenceEvents } from '../constants';

/**
 * Domain mutation events for event occurrences and availability votes (#57
 * emit-site migration).
 *
 * Payloads carry ROW STATE (before/after snapshots) plus listener-facing
 * context fields; the acting actor, source, and correlationId live in CLS and
 * are read at handle time — never on the payload. All events here are audited
 * by default (opt out per class with `@Auditable(false)`); only before/after
 * reach the audit row, so context fields stay out of persistence.
 */

type OccurrenceAddedSnapshot = Readonly<
  Pick<EventOccurrence, 'id' | 'eventId' | 'label' | 'startDate' | 'endDate' | 'location' | 'status' | 'sortOrder'>
>;

export class OccurrenceAddedEvent extends MutationEvent<EventOccurrence> {
  static readonly eventName = OccurrenceEvents.OccurrenceAdded;

  declare readonly before: null;
  declare readonly after: OccurrenceAddedSnapshot;

  readonly subject = ResourceType.EventOccurrence;
  readonly subjectId: string;

  constructor(after: OccurrenceAddedSnapshot, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type OccurrenceUpdatedSnapshot = Readonly<Partial<EventOccurrence> & Pick<EventOccurrence, 'id'>>;

/** before/after carry the changed subset only (plus `id`). */
export class OccurrenceUpdatedEvent extends MutationEvent<EventOccurrence> {
  static readonly eventName = OccurrenceEvents.OccurrenceUpdated;

  declare readonly before: OccurrenceUpdatedSnapshot;
  declare readonly after: OccurrenceUpdatedSnapshot;

  readonly subject = ResourceType.EventOccurrence;
  readonly subjectId: string;

  constructor(before: OccurrenceUpdatedSnapshot, after: OccurrenceUpdatedSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** Changed subset (`status`) plus `eventId`, which occurrence-change listeners key off. */
type OccurrenceStatusSnapshot = Readonly<Pick<EventOccurrence, 'id' | 'eventId' | 'status'>>;

/**
 * A status transition (Proposed→Confirmed/Declined, Confirmed→Cancelled).
 * One class serves all three transitions, so there is deliberately NO static
 * `eventName`: the emit site selects the matching `OccurrenceEvents` member
 * from the target status and the audit listener records whichever name was
 * actually emitted.
 */
export class OccurrenceStatusChangedEvent extends MutationEvent<EventOccurrence> {
  declare readonly before: OccurrenceStatusSnapshot;
  declare readonly after: OccurrenceStatusSnapshot;

  readonly subject = ResourceType.EventOccurrence;
  readonly subjectId: string;

  constructor(before: OccurrenceStatusSnapshot, after: OccurrenceStatusSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type AvailabilityVoteSnapshot = Readonly<Partial<EventAvailabilityVote> & Pick<EventAvailabilityVote, 'id'>>;

/**
 * Upsert of an EventAvailabilityVote: create-shaped on the first vote
 * (`before === null`, full-row after), update-shaped on a re-vote (changed
 * `response` subset on both sides).
 */
export class AvailabilityVoteSubmittedEvent extends MutationEvent<EventAvailabilityVote> {
  static readonly eventName = OccurrenceEvents.AvailabilityVoteSubmitted;

  declare readonly before: AvailabilityVoteSnapshot | null;
  declare readonly after: AvailabilityVoteSnapshot;

  readonly subject = ResourceType.EventAvailabilityVote;
  readonly subjectId: string;

  constructor(before: AvailabilityVoteSnapshot | null, after: AvailabilityVoteSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}
