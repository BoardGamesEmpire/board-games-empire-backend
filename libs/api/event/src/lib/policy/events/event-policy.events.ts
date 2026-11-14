import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type EventOccurrencePolicy, type EventPolicy } from '@bge/database';
import { EventEvents } from '../../constants/event-events.constant';
import { OccurrenceEvents } from '../../occurrence/constants';
import type { EventPolicyView, OccurrencePolicyView } from '../policy-view';

/**
 * Domain mutation events for an event's policy (#796).
 *
 * Payloads carry ROW STATE (before/after snapshots) plus listener-facing
 * context fields; the acting actor, source, and correlationId live in CLS and
 * are read at handle time — never on the payload. All events here are audited
 * by default (opt out per class with `@Auditable(false)`); only before/after
 * reach the audit entry, so context fields stay out of persistence.
 */

type EventPolicyUpdatedSnapshot = Readonly<Partial<EventPolicyView> & Pick<EventPolicy, 'id'>>;

/**
 * before/after carry the changed subset only (plus `id`), as every update's audit entry does (#728).
 * A changed allowed list is in it by its list name, as the ids or types it held (#1268).
 */
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

type OccurrencePolicyUpdatedSnapshot = Readonly<Partial<OccurrencePolicyView> & Pick<EventOccurrencePolicy, 'id'>>;

/**
 * A change to a date's own policy (#796). It is filed on the date, so the
 * date's audit trail shows it. before/after carry the changed subset only
 * (plus the policy row's `id`), as every update's audit entry does (#728); a
 * changed allowed list is in it by its list name. Before the date's first
 * write, every field was the event's: `null`, an empty list, or no flag.
 */
export class OccurrencePolicyUpdatedEvent extends MutationEvent<EventOccurrencePolicy> {
  static readonly eventName = OccurrenceEvents.OccurrencePolicyUpdated;

  declare readonly before: OccurrencePolicyUpdatedSnapshot;
  declare readonly after: OccurrencePolicyUpdatedSnapshot;

  readonly subject = ResourceType.EventOccurrence;
  readonly subjectId: string;

  constructor(
    before: OccurrencePolicyUpdatedSnapshot,
    after: OccurrencePolicyUpdatedSnapshot,
    /** The date whose policy changed. */
    occurrenceId: string,
    /** The event the date belongs to. Context for listeners, not audited. */
    public readonly eventId: string,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = occurrenceId;
  }
}
