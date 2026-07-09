import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type EventAttendee, type EventAttendeeGameList } from '@bge/database';
import { AttendeeEvents } from '../constants';

/**
 * Domain mutation events for event attendees and their game lists (#57
 * emit-site migration).
 *
 * Payloads carry ROW STATE (before/after snapshots) plus listener-facing
 * context fields; the acting actor, source, and correlationId live in CLS and
 * are read at handle time — never on the payload. All events here are audited
 * by default (opt out per class with `@Auditable(false)`); only before/after
 * reach the audit row, so context fields stay out of persistence.
 */

type AttendeeAddedSnapshot = Readonly<
  Pick<EventAttendee, 'id' | 'eventId' | 'userId' | 'guestName' | 'status' | 'invitedById'>
>;

export class AttendeeAddedEvent extends MutationEvent<EventAttendee> {
  static readonly eventName = AttendeeEvents.AttendeeAdded;

  declare readonly before: null;
  declare readonly after: AttendeeAddedSnapshot;

  readonly subject = ResourceType.EventAttendee;
  readonly subjectId: string;

  constructor(after: AttendeeAddedSnapshot, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type AttendeeRemovedSnapshot = Readonly<Pick<EventAttendee, 'id' | 'eventId' | 'userId' | 'guestName' | 'status'>>;

export class AttendeeRemovedEvent extends MutationEvent<EventAttendee> {
  static readonly eventName = AttendeeEvents.AttendeeRemoved;

  declare readonly before: AttendeeRemovedSnapshot;
  declare readonly after: null;

  readonly subject = ResourceType.EventAttendee;
  readonly subjectId: string;

  constructor(before: AttendeeRemovedSnapshot, initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}

/** Changed subset (`status`) plus the row fields RSVP listeners key off. */
type AttendeeStatusSnapshot = Readonly<Pick<EventAttendee, 'id' | 'eventId' | 'userId' | 'status'>>;

export class AttendeeStatusUpdatedEvent extends MutationEvent<EventAttendee> {
  static readonly eventName = AttendeeEvents.AttendeeStatusUpdated;

  declare readonly before: AttendeeStatusSnapshot;
  declare readonly after: AttendeeStatusSnapshot;

  readonly subject = ResourceType.EventAttendee;
  readonly subjectId: string;

  constructor(before: AttendeeStatusSnapshot, after: AttendeeStatusSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type GameListEntrySnapshot = Readonly<Pick<EventAttendeeGameList, 'id' | 'attendeeId' | 'collectionId'>>;

/**
 * A specific EventAttendeeGameList row was created — the row mutation (not an
 * aggregate "list changed" signal) is the auditable fact. Carries its own
 * event name, distinct from {@link GameRemovedFromListEvent}, so the audit
 * notifier's per-name dedupe can't mask one path behind the other.
 */
export class GameAddedToListEvent extends MutationEvent<EventAttendeeGameList> {
  static readonly eventName = AttendeeEvents.GameAddedToList;

  declare readonly before: null;
  declare readonly after: GameListEntrySnapshot;

  readonly subject = ResourceType.EventAttendeeGameList;
  readonly subjectId: string;

  constructor(
    after: GameListEntrySnapshot,
    /** Parent event id — context for listeners; the row only stores attendeeId. */
    public readonly eventId: string,
    initiatedAt: Date,
  ) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** A specific EventAttendeeGameList row was deleted. See {@link GameAddedToListEvent}. */
export class GameRemovedFromListEvent extends MutationEvent<EventAttendeeGameList> {
  static readonly eventName = AttendeeEvents.GameRemovedFromList;

  declare readonly before: GameListEntrySnapshot;
  declare readonly after: null;

  readonly subject = ResourceType.EventAttendeeGameList;
  readonly subjectId: string;

  constructor(
    before: GameListEntrySnapshot,
    /** Parent event id — context for listeners; the row only stores attendeeId. */
    public readonly eventId: string,
    initiatedAt: Date,
  ) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}
