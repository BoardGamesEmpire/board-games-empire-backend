import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type EventPolicy } from '@bge/database';
import { EventEvents } from '../../constants/event-events.constant';

/**
 * Domain mutation events for an event's policy (#796).
 *
 * Payloads carry ROW STATE (before/after snapshots) plus listener-facing
 * context fields; the acting actor, source, and correlationId live in CLS and
 * are read at handle time — never on the payload. All events here are audited
 * by default (opt out per class with `@Auditable(false)`); only before/after
 * reach the audit row, so context fields stay out of persistence.
 */

type EventPolicyUpdatedSnapshot = Readonly<Partial<EventPolicy> & Pick<EventPolicy, 'id'>>;

/** before/after carry the changed subset only (plus `id`), as every update's audit row does (#728). */
export class EventPolicyUpdatedEvent extends MutationEvent<EventPolicy> {
  static readonly eventName = EventEvents.EventPolicyUpdated;

  declare readonly before: EventPolicyUpdatedSnapshot;
  declare readonly after: EventPolicyUpdatedSnapshot;

  readonly subject = ResourceType.EventPolicy;
  readonly subjectId: string;

  constructor(
    before: EventPolicyUpdatedSnapshot,
    after: EventPolicyUpdatedSnapshot,
    /** The event whose policy changed. Context for listeners, not audited. */
    public readonly eventId: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}
