import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type EventGame, type EventGameNomination, type EventGameVote } from '@bge/database';
import { NominationEvent } from '../constants';

/**
 * Domain mutation events for game nominations, votes, and event-game rows
 * (#57 emit-site migration).
 *
 * Payloads carry ROW STATE (before/after snapshots) plus listener-facing
 * context fields; the acting actor, source, and correlationId live in CLS and
 * are read at handle time — never on the payload. All events here are audited
 * by default (opt out per class with `@Auditable(false)`); only before/after
 * reach the audit row, so context fields stay out of persistence.
 */

type NominationCreatedSnapshot = Readonly<
  Pick<
    EventGameNomination,
    'id' | 'eventId' | 'occurrenceId' | 'platformGameId' | 'nominatedById' | 'suppliedFromId' | 'status' | 'votingDeadline'
  >
>;

export class NominationCreatedEvent extends MutationEvent<EventGameNomination> {
  static readonly eventName = NominationEvent.NominationCreated;

  declare readonly before: null;
  declare readonly after: NominationCreatedSnapshot;

  readonly subject = ResourceType.EventGameNomination;
  readonly subjectId: string;

  constructor(after: NominationCreatedSnapshot, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** Changed subset (`status`) plus `eventId` for listeners. */
type NominationStatusSnapshot = Readonly<Pick<EventGameNomination, 'id' | 'eventId' | 'status'>>;

export class NominationWithdrawnEvent extends MutationEvent<EventGameNomination> {
  static readonly eventName = NominationEvent.NominationWithdrawn;

  declare readonly before: NominationStatusSnapshot;
  declare readonly after: NominationStatusSnapshot;

  readonly subject = ResourceType.EventGameNomination;
  readonly subjectId: string;

  constructor(before: NominationStatusSnapshot, after: NominationStatusSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/** Changed subset (`status`) plus the row fields resolution listeners key off. */
type NominationResolvedSnapshot = Readonly<Pick<EventGameNomination, 'id' | 'eventId' | 'platformGameId' | 'status'>>;

/** A nomination left the Open/AwaitingApproval state (vote resolution or host decision). */
export class NominationResolvedEvent extends MutationEvent<EventGameNomination> {
  static readonly eventName = NominationEvent.NominationResolved;

  declare readonly before: NominationResolvedSnapshot;
  declare readonly after: NominationResolvedSnapshot;

  readonly subject = ResourceType.EventGameNomination;
  readonly subjectId: string;

  constructor(
    before: NominationResolvedSnapshot,
    after: NominationResolvedSnapshot,
    /** EventGame row created by this resolution, when it passed — context, not nomination row state. */
    public readonly elevatedToEventGameId: string | null,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type VoteCastSnapshot = Readonly<Partial<EventGameVote> & Pick<EventGameVote, 'id'>>;

/**
 * Upsert of an EventGameVote: create-shaped on the first vote
 * (`before === null`, full-row after), update-shaped on a changed vote
 * (changed subset on both sides).
 */
export class VoteCastEvent extends MutationEvent<EventGameVote> {
  static readonly eventName = NominationEvent.VoteCast;

  declare readonly before: VoteCastSnapshot | null;
  declare readonly after: VoteCastSnapshot;

  readonly subject = ResourceType.EventGameVote;
  readonly subjectId: string;

  constructor(before: VoteCastSnapshot | null, after: VoteCastSnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

type EventGameAddedSnapshot = Readonly<
  Pick<EventGame, 'id' | 'eventId' | 'occurrenceId' | 'platformGameId' | 'suppliedById' | 'nominationId' | 'addedById' | 'role'>
>;

/** An EventGame row was created — via direct add or elevation from a passed nomination. */
export class GameAddedToEventEvent extends MutationEvent<EventGame> {
  static readonly eventName = NominationEvent.GameAddedToEvent;

  declare readonly before: null;
  declare readonly after: EventGameAddedSnapshot;

  readonly subject = ResourceType.EventGame;
  readonly subjectId: string;

  constructor(
    after: EventGameAddedSnapshot,
    /** Parent event id — the row's own `eventId` is null for occurrence-scoped games. */
    public readonly eventId: string,
    /**
     * Attendee the addition is attributed to: the direct adder (also on the
     * row as `addedById`), or the nominator when elevated from a nomination
     * (row `addedById` is null). Context for notification exclusion — not
     * the CLS actor.
     */
    public readonly addedByAttendeeId: string,
    initiatedAt: Date,
  ) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}
