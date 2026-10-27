import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type Event } from '@bge/database';
import { EventEvents } from '../../constants/event-events.constant';

/**
 * Domain mutation events for an event's host decisions: cancel and reopen
 * (#795). Each carries the event's cancel columns before and after, plus the
 * title its notice names; the acting user rides along as a context field for
 * the notice's audience, which leaves them out. Audited by default; only
 * before/after reach the audit row.
 */

type EventCancelSnapshot = Readonly<
  Pick<Event, 'id' | 'title' | 'householdId' | 'cancelledAt' | 'cancelledById' | 'cancelReason'>
>;

/** The host called the event off; its dates were cancelled with it. */
export class EventCancelledEvent extends MutationEvent<Event> {
  static readonly eventName = EventEvents.EventCancelled;

  declare readonly before: EventCancelSnapshot;
  declare readonly after: EventCancelSnapshot;

  readonly subject = ResourceType.Event;
  readonly subjectId: string;

  constructor(
    before: EventCancelSnapshot,
    after: EventCancelSnapshot,
    /** Who cancelled it — context for the notice's audience, not row state. */
    public readonly actingUserId: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** The host reopened a cancelled event; its dates stay as cancel left them. */
export class EventReopenedEvent extends MutationEvent<Event> {
  static readonly eventName = EventEvents.EventReopened;

  declare readonly before: EventCancelSnapshot;
  declare readonly after: EventCancelSnapshot;

  readonly subject = ResourceType.Event;
  readonly subjectId: string;

  constructor(
    before: EventCancelSnapshot,
    after: EventCancelSnapshot,
    /** Who reopened it — context for the notice's audience, not row state. */
    public readonly actingUserId: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}
