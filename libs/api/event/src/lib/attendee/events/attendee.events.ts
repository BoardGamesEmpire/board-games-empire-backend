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

/** The removed row an add revived (#551). */
type AttendeeRevivedSnapshot = Readonly<Pick<EventAttendee, 'id' | 'status' | 'invitedById' | 'removedAt'>>;

/**
 * An attendee was added: create-shaped for a new row, update-shaped when the
 * add revived the row of a user a host had removed (#551).
 */
export class AttendeeAddedEvent extends MutationEvent<EventAttendee> {
  static readonly eventName = AttendeeEvents.AttendeeAdded;

  declare readonly before: AttendeeRevivedSnapshot | null;
  declare readonly after: AttendeeAddedSnapshot & Partial<Pick<EventAttendee, 'removedAt'>>;

  readonly subject = ResourceType.EventAttendee;
  readonly subjectId: string;

  constructor(
    before: AttendeeRevivedSnapshot | null,
    after: AttendeeAddedSnapshot & Partial<Pick<EventAttendee, 'removedAt'>>,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type AttendeeRemovedSnapshot = Readonly<
  Pick<EventAttendee, 'id' | 'eventId' | 'userId' | 'guestName' | 'status' | 'removedAt'>
>;

/**
 * A host removed an attendee. The row stays, marked removed, so this is an
 * update of `removedAt` (#551).
 */
export class AttendeeRemovedEvent extends MutationEvent<EventAttendee> {
  static readonly eventName = AttendeeEvents.AttendeeRemoved;

  declare readonly before: AttendeeRemovedSnapshot;
  declare readonly after: AttendeeRemovedSnapshot;

  readonly subject = ResourceType.EventAttendee;
  readonly subjectId: string;

  constructor(before: AttendeeRemovedSnapshot, after: AttendeeRemovedSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
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

type GameListEntrySnapshot = Readonly<Pick<EventAttendeeGameList, 'id' | 'attendeeId' | 'collectionId' | 'removedAt'>>;

/**
 * A game went on an attendee's list — the row mutation (not an aggregate
 * "list changed" signal) is the auditable fact. Create-shaped for a new row,
 * update-shaped when the game had been taken off the list and its row is
 * revived (#551). Carries its own event name, distinct from
 * {@link GameRemovedFromListEvent}, so the audit notifier's per-name dedupe
 * can't mask one path behind the other.
 */
export class GameAddedToListEvent extends MutationEvent<EventAttendeeGameList> {
  static readonly eventName = AttendeeEvents.GameAddedToList;

  declare readonly before: GameListEntrySnapshot | null;
  declare readonly after: GameListEntrySnapshot;

  readonly subject = ResourceType.EventAttendeeGameList;
  readonly subjectId: string;

  constructor(
    before: GameListEntrySnapshot | null,
    after: GameListEntrySnapshot,
    /** Parent event id — context for listeners; the row only stores attendeeId. */
    public readonly eventId: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * A game came off an attendee's list. The row stays, marked removed, because
 * closed nominations still name it as their supplier, so this is an update of
 * `removedAt` (#551). See {@link GameAddedToListEvent}.
 */
export class GameRemovedFromListEvent extends MutationEvent<EventAttendeeGameList> {
  static readonly eventName = AttendeeEvents.GameRemovedFromList;

  declare readonly before: GameListEntrySnapshot;
  declare readonly after: GameListEntrySnapshot;

  readonly subject = ResourceType.EventAttendeeGameList;
  readonly subjectId: string;

  constructor(
    before: GameListEntrySnapshot,
    after: GameListEntrySnapshot,
    /** Parent event id — context for listeners; the row only stores attendeeId. */
    public readonly eventId: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}
