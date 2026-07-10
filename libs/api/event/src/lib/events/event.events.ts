import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type Event } from '@bge/database';
import { EventEvents } from '../constants/event-events.constant';

/**
 * Domain mutation events for the Event aggregate (#57 emit-site migration).
 *
 * Payloads carry ROW STATE (before/after snapshots) plus listener-facing
 * context fields; the acting actor, source, and correlationId live in CLS and
 * are read at handle time — never on the payload. All events here are audited
 * by default (opt out per class with `@Auditable(false)`); only before/after
 * reach the audit row, so context fields stay out of persistence.
 */

type EventCreatedSnapshot = Readonly<
  Pick<Event, 'id' | 'title' | 'status' | 'schedulingMode' | 'createdById' | 'householdId'>
>;

export class EventCreatedEvent extends MutationEvent<Event> {
  static readonly eventName = EventEvents.EventCreated;

  declare readonly before: null;
  declare readonly after: EventCreatedSnapshot;

  readonly subject = ResourceType.Event;
  readonly subjectId: string;

  constructor(
    after: EventCreatedSnapshot,
    /** Users invited at creation — context for invite notifications, not row state. */
    public readonly invitedUserIds: readonly string[],
    initiatedAt: Date,
  ) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type EventUpdatedSnapshot = Readonly<Partial<Event> & Pick<Event, 'id'>>;

/** before/after carry the changed subset only (plus `id`). */
export class EventUpdatedEvent extends MutationEvent<Event> {
  static readonly eventName = EventEvents.EventUpdated;

  declare readonly before: EventUpdatedSnapshot;
  declare readonly after: EventUpdatedSnapshot;

  readonly subject = ResourceType.Event;
  readonly subjectId: string;

  constructor(before: EventUpdatedSnapshot, after: EventUpdatedSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type EventDeletedSnapshot = Readonly<Pick<Event, 'id' | 'title' | 'createdById' | 'householdId'>>;

/** Soft delete (deletedAt stamp) modeled as a domain delete: before-only. */
export class EventDeletedEvent extends MutationEvent<Event> {
  static readonly eventName = EventEvents.EventDeleted;

  declare readonly before: EventDeletedSnapshot;
  declare readonly after: null;

  readonly subject = ResourceType.Event;
  readonly subjectId: string;

  constructor(before: EventDeletedSnapshot, initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}
