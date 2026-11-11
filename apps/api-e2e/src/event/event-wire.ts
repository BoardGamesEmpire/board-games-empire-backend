import type {
  Event,
  EventAttendee,
  EventAvailabilityVote,
  EventGame,
  EventGameNomination,
  EventGameVote,
  EventOccurrence,
  EventParticipationStatus,
  EventPolicy,
  EventStatus,
  Game,
  GameMedium,
  Platform,
  PlatformGame,
  User,
  UserProfile,
} from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the event envelopes, on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

/**
 * How the acting user attends an event (#867). Restated rather than imported from
 * `@bge/event`, since the suite checks the wire contract and not the service's
 * own type.
 */
export interface EventAttendanceWire {
  readonly attendeeId: string;
  readonly status: EventParticipationStatus;
  readonly role: string | null;
  readonly rsvpDate: string | null;
}

/**
 * An event as every event route serves it: the row, plus the `status` worked
 * out from its cancel, archive and confirmed dates, never stored (#795).
 */
export type EventWire = Wire<Event> & {
  readonly status: EventStatus;
};
export type EventAttendeeWire = Wire<EventAttendee>;
export type EventGameWire = Wire<EventGame>;

/**
 * An event as the reads serve it, with how the acting user attends (#867).
 * Create, update and lifecycle responses don't carry `attendance`.
 */
export type EventReadWire = EventWire & {
  readonly attendance: EventAttendanceWire | null;
};

export interface ListEventsEnvelope {
  readonly events: readonly EventReadWire[];
  readonly total: number;
}

/**
 * One game on an occurrence, as the occurrence routes embed it: the lineup
 * row's key fields, and the platform game it schedules with its game and
 * platform. The columns are picked from the models, so renaming one fails
 * typecheck here. The relation keys and `platformGame.id` are written out.
 */
export type OccurrenceGameWire = Pick<EventGameWire, 'id' | 'platformGameId' | 'role'> & {
  readonly platformGame: {
    readonly id: string;
    readonly game: Pick<Wire<Game>, 'id' | 'title' | 'thumbnail'>;
    readonly platform: Pick<Wire<Platform>, 'id' | 'name' | 'platformType'>;
  };
};

/**
 * One availability vote on an occurrence, as the occurrence routes embed it,
 * with the voter's user and whether the vote counts (#551).
 */
export type OccurrenceVoteWire = Pick<Wire<EventAvailabilityVote>, 'id' | 'attendeeId' | 'response'> & {
  readonly attendee: { readonly userId: string | null };
  readonly eligible: boolean;
};

/** One vote on a nomination, as the nomination routes embed it, marked with whether it counts (#551). */
export type NominationVoteWire = Pick<Wire<EventGameVote>, 'id' | 'attendeeId' | 'voteType'> & {
  readonly eligible: boolean;
};

/** A nomination as its routes serve it: who made it, whose list supplies it, and its votes. */
export type NominationWire = Wire<EventGameNomination> & {
  readonly nominatedBy: { readonly id: string; readonly user: { readonly id: string } | null };
  readonly suppliedFrom: { readonly id: string };
  readonly votes: readonly NominationVoteWire[];
};

/** `POST /api/events/:eventId/nominations/:nominationId/resolve`'s outcome, restated to the fields a spec asserts on. */
export interface ResolutionWire {
  readonly status: string;
  readonly tally: { readonly forCount: number; readonly againstCount: number; readonly totalVotes: number };
  readonly eligibleVoterCount: number;
}

/** An occurrence as its routes serve it, with its votes and games. */
export type EventOccurrenceWire = Wire<EventOccurrence> & {
  readonly availabilityVotes: readonly OccurrenceVoteWire[];
  readonly games: readonly OccurrenceGameWire[];
};

/**
 * `GET /api/events/:id`'s event, with its occurrences, attendees and policy.
 * Each comes from a read under its own type's ceiling (#560), so a caller
 * without a read on one gets `[]` for it, or `null` for the policy.
 */
export type EventDetailWire = EventReadWire & EventEmbedsWire;

/** The embeds a create's replay shares with the event read. */
export interface EventEmbedsWire {
  readonly occurrences: readonly Wire<EventOccurrence>[];
  readonly attendees: readonly EventAttendeeWire[];
  readonly policy: Wire<EventPolicy> | null;
}

/** A create's replay: the event and its embeds, without `attendance` (#867). */
export type EventReplayWire = EventWire & EventEmbedsWire;

export interface ListOccurrencesEnvelope {
  readonly occurrences: readonly EventOccurrenceWire[];
  readonly total: number;
}

export interface ListAttendeesEnvelope {
  readonly attendees: readonly EventAttendeeWire[];
  readonly total: number;
}

/**
 * An offered game as the reads and the add serve it (#1185, #1187), restated
 * rather than imported from `@bge/event`, since the suite checks the wire
 * contract. Its collection entry carries its id and medium, and nothing else
 * of the owner's row.
 */
export interface OfferedGameWire {
  readonly id: string;
  readonly attendeeId: string;
  readonly createdAt: string;
  readonly collection: {
    readonly id: string;
    readonly medium: GameMedium;
    readonly platformGame: Pick<
      Wire<PlatformGame>,
      'id' | 'image' | 'thumbnail' | 'minPlayers' | 'maxPlayers' | 'minPlayTime' | 'maxPlayTime'
    > & {
      readonly platform: Pick<Wire<Platform>, 'id' | 'name' | 'slug' | 'platformType'>;
      readonly game: Pick<
        Wire<Game>,
        | 'id'
        | 'title'
        | 'subtitle'
        | 'thumbnail'
        | 'image'
        | 'contentType'
        | 'publishYear'
        | 'complexity'
        | 'minPlayers'
        | 'maxPlayers'
        | 'minPlayTime'
        | 'maxPlayTime'
      > & { readonly baseGames: readonly { readonly gameId: string; readonly isStandalone: boolean }[] };
    };
  };
  readonly supplies: { readonly nominations: number | null; readonly lineup: number | null };
}

/** A row of `GET /api/events/:eventId/offered-games`: the offered game and its attendee, or null (#1187). */
export type OfferedGameRowWire = OfferedGameWire & {
  readonly attendee: {
    readonly id: string;
    readonly status: EventParticipationStatus;
    readonly guestName: string | null;
    readonly user:
      | (Pick<Wire<User>, 'id' | 'username'> & {
          readonly profile: Pick<Wire<UserProfile>, 'displayName' | 'avatarUrl'> | null;
        })
      | null;
  } | null;
};

export interface ListOfferedGamesEnvelope {
  readonly offeredGames: readonly OfferedGameRowWire[];
  readonly total: number;
}

export interface ListAttendeeGamesEnvelope {
  readonly games: readonly OfferedGameWire[];
  readonly total: number;
}

/**
 * One occurrence's entry in the availability summary, restated to the fields
 * a spec asserts on.
 */
export interface AvailabilitySummaryEntryWire {
  readonly occurrenceId: string;
  readonly available: number;
  readonly maybe: number;
  readonly unavailable: number;
  readonly totalVotes: number;
  readonly pendingVotes: number;
  readonly participationRate: number;
  readonly voters: readonly { readonly attendeeId: string; readonly response: string; readonly eligible: boolean }[];
}

/**
 * The availability summary. Restated rather than imported from `@bge/event`,
 * since the suite checks the wire contract and not the service's own type.
 */
export interface AvailabilitySummaryWire {
  readonly attendees: {
    readonly total: number;
    readonly registered: number;
    readonly guests: number;
    readonly byStatus: {
      readonly attending: number;
      readonly invited: number;
      readonly maybe: number;
      readonly notAttending: number;
    };
  };
  readonly eligibleVoters: number;
  readonly occurrences: readonly AvailabilitySummaryEntryWire[];
}

const fail = envelopeFailure('apps/api-e2e/src/event/event-wire.ts');

/**
 * Only `id` is checked: a row without one means the envelope changed. The
 * suite's other field assertions need no check here, since each compares
 * against a definite value that `undefined` fails.
 */
function withId<TRow>(value: unknown): TRow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = value['id'];

  return typeof id === 'string' && id.length > 0 ? (value as unknown as TRow) : undefined;
}

/** `POST /api/events`, `PATCH /api/events/:id`: `{ message, event }`. `GET /api/events/:id`: `{ event }`. */
export function eventEnvelope(response: HttpResponseLike, request: RequestDescription): EventWire {
  const event = isRecord(response.body) ? withId<EventWire>(response.body['event']) : undefined;

  return event ?? fail("it carried no 'event' object with a string id", request, response);
}

/** Whether `value` carries `attendance`, an object or `null`: a read's row without the key changed shape (#867). */
function hasAttendance(value: { readonly attendance?: unknown }): boolean {
  return value.attendance === null || isRecord(value.attendance);
}

/**
 * A create's replay: `{ message, event }`, with the event's `occurrences` and
 * `attendees` arrays and its `policy`, an object or `null`. A missing key
 * means the response's shape changed, not that the caller was refused one.
 */
export function eventReplayEnvelope(response: HttpResponseLike, request: RequestDescription): EventReplayWire {
  const event = isRecord(response.body) ? withId<EventReplayWire>(response.body['event']) : undefined;
  const complete =
    event !== undefined &&
    Array.isArray(event.occurrences) &&
    Array.isArray(event.attendees) &&
    (event.policy === null || isRecord(event.policy));

  return complete
    ? event
    : fail(
        "it carried no 'event' with a string id, 'occurrences' and 'attendees' arrays, and a 'policy' object or null",
        request,
        response,
      );
}

/** `GET /api/events/:id`: `{ event }`, as {@link eventReplayEnvelope} checks it, plus `attendance`. */
export function eventDetailEnvelope(response: HttpResponseLike, request: RequestDescription): EventDetailWire {
  const event = eventReplayEnvelope(response, request) as EventReplayWire & { readonly attendance?: unknown };

  return hasAttendance(event)
    ? (event as EventDetailWire)
    : fail("its 'event' carried no 'attendance' object or null", request, response);
}

/** What a row must be for {@link withId}. */
const ROW_WITH_ID = 'an object with a string id';

/** What a row must be for {@link eventRow}. */
const EVENT_ROW = "an object with a string id and an 'attendance' object or null";

/** An event list's row: an id, and `attendance`, which every list read carries (#867). */
function eventRow(value: unknown): EventReadWire | undefined {
  const row = withId<EventReadWire>(value);

  return row !== undefined && hasAttendance(row) ? row : undefined;
}

/** What a row must be for {@link occurrenceRow}. */
const OCCURRENCE_ROW = "an object with a string id, an 'availabilityVotes' array and a 'games' array";

/**
 * A paginated list's rows under `key`, and its `pagination.total`. The total
 * is checked against the page because both count the same caller-scoped set
 * (#372): a total below the rows on screen means the two disagree about scope.
 * Each row passes `parseRow`, which accepts `rowShape`, or the envelope fails.
 */
function paginatedEnvelope<TRow>(
  key: string,
  parseRow: (value: unknown) => TRow | undefined,
  rowShape: string,
  response: HttpResponseLike,
  request: RequestDescription,
): { rows: TRow[]; total: number } {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const entries = response.body[key];
  if (!Array.isArray(entries)) {
    return fail(`it carried no '${key}' array`, request, response);
  }

  const rows: TRow[] = [];
  for (const entry of entries) {
    const row = parseRow(entry);
    if (row === undefined) {
      return fail(`one of its ${key} is not ${rowShape}`, request, response);
    }

    rows.push(row);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { rows, total };
}

/** `GET /api/events` and the other event lists: `{ events: [...], pagination }`. */
export function listEventsEnvelope(response: HttpResponseLike, request: RequestDescription): ListEventsEnvelope {
  const { rows, total } = paginatedEnvelope('events', eventRow, EVENT_ROW, response, request);

  return { events: rows, total };
}

/**
 * An occurrence row: an id, and `availabilityVotes` and `games` arrays, since
 * the embeds are what a renamed include, or a read of its own that stopped
 * serving its key, breaks. The votes and games themselves are compared
 * against definite values by the specs.
 */
function occurrenceRow(value: unknown): EventOccurrenceWire | undefined {
  const row = withId<EventOccurrenceWire>(value);

  return row !== undefined && Array.isArray(row.availabilityVotes) && Array.isArray(row.games) ? row : undefined;
}

/**
 * `GET /api/events/:eventId/occurrences/:occurrenceId`: `{ occurrence }`. The
 * occurrence writes (`POST`, `PATCH`, `DELETE`, and the status transitions)
 * answer `{ message, occurrence }`.
 */
export function occurrenceEnvelope(response: HttpResponseLike, request: RequestDescription): EventOccurrenceWire {
  const occurrence = isRecord(response.body) ? occurrenceRow(response.body['occurrence']) : undefined;

  return occurrence ?? fail(`it carried no 'occurrence' that is ${OCCURRENCE_ROW}`, request, response);
}

/** `GET /api/events/:eventId/occurrences`: `{ occurrences: [...], pagination }`. */
export function listOccurrencesEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): ListOccurrencesEnvelope {
  const { rows, total } = paginatedEnvelope('occurrences', occurrenceRow, OCCURRENCE_ROW, response, request);

  return { occurrences: rows, total };
}

/** `GET /api/events/:eventId/attendees`: `{ attendees: [...], pagination }`, paged since #373. */
export function listAttendeesEnvelope(response: HttpResponseLike, request: RequestDescription): ListAttendeesEnvelope {
  const { rows, total } = paginatedEnvelope('attendees', withId<EventAttendeeWire>, ROW_WITH_ID, response, request);

  return { attendees: rows, total };
}

/**
 * `GET /api/events/:eventId/occurrences/summary/availability`: `{ summary }`.
 * Only the containers are checked. The specs compare the counts against
 * definite values, which `undefined` fails.
 */
export function availabilitySummaryEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): AvailabilitySummaryWire {
  const summary = isRecord(response.body) ? response.body['summary'] : undefined;

  if (!isRecord(summary) || !isRecord(summary['attendees']) || !Array.isArray(summary['occurrences'])) {
    return fail(
      "it carried no 'summary' object with an 'attendees' object and an 'occurrences' array",
      request,
      response,
    );
  }

  return summary as unknown as AvailabilitySummaryWire;
}

/** `POST /api/events/:eventId/attendees`: `{ message, attendee }`. */
export function attendeeEnvelope(response: HttpResponseLike, request: RequestDescription): EventAttendeeWire {
  const attendee = isRecord(response.body) ? withId<EventAttendeeWire>(response.body['attendee']) : undefined;

  return attendee ?? fail("it carried no 'attendee' object with a string id", request, response);
}

/** `POST /api/events/:eventId/nominations/direct-add`: `{ message, eventGame }`. */
export function eventGameEnvelope(response: HttpResponseLike, request: RequestDescription): EventGameWire {
  const eventGame = isRecord(response.body) ? withId<EventGameWire>(response.body['eventGame']) : undefined;

  return eventGame ?? fail("it carried no 'eventGame' object with a string id", request, response);
}

/** The nomination routes, the list excepted: `{ nomination }`, beside a `message` on the writes. */
export function nominationEnvelope(response: HttpResponseLike, request: RequestDescription): NominationWire {
  const nomination = isRecord(response.body) ? withId<NominationWire>(response.body['nomination']) : undefined;

  if (!nomination || !Array.isArray(nomination.votes)) {
    return fail("it carried no 'nomination' object with a string id and a 'votes' array", request, response);
  }

  return nomination;
}

/** `POST /api/events/:eventId/nominations/:nominationId/resolve`: `{ message, nomination, resolution }`. */
export function resolutionEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): { nomination: NominationWire; resolution: ResolutionWire } {
  const resolution = isRecord(response.body) ? response.body['resolution'] : undefined;

  if (!isRecord(resolution) || !isRecord(resolution['tally'])) {
    return fail("it carried no 'resolution' object with a 'tally' object", request, response);
  }

  return { nomination: nominationEnvelope(response, request), resolution: resolution as unknown as ResolutionWire };
}

/** What a row must be for {@link offeredGameRow}. */
const OFFERED_GAME_ROW = "an object with a string id, a 'collection' object and a 'supplies' object";

/**
 * An offered game: an id, its collection entry and its supplies, since those
 * are what a renamed select or a dropped enrichment breaks. The fields are
 * compared against definite values by the specs.
 */
function offeredGameRow(value: unknown): OfferedGameWire | undefined {
  const row = withId<OfferedGameWire>(value);

  return row !== undefined && isRecord(row.collection) && isRecord(row.supplies) ? row : undefined;
}

/** What a row must be for {@link offeredGameListRow}. */
const OFFERED_GAME_LIST_ROW = `${OFFERED_GAME_ROW}, and an 'attendee' object or null`;

/** An offered-games row: an offered game, and its `attendee`, an object or `null` (#1187). */
function offeredGameListRow(value: unknown): OfferedGameRowWire | undefined {
  const row = offeredGameRow(value) as (OfferedGameWire & { readonly attendee?: unknown }) | undefined;

  return row !== undefined && (row.attendee === null || isRecord(row.attendee))
    ? (row as OfferedGameRowWire)
    : undefined;
}

/** `GET /api/events/:eventId/offered-games`: `{ offeredGames: [...], pagination }` (#1187). */
export function listOfferedGamesEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): ListOfferedGamesEnvelope {
  const { rows, total } = paginatedEnvelope(
    'offeredGames',
    offeredGameListRow,
    OFFERED_GAME_LIST_ROW,
    response,
    request,
  );

  return { offeredGames: rows, total };
}

/** `GET /api/events/:eventId/attendees/:attendeeId/games`: `{ games: [...], pagination }`, paged since #1001. */
export function listAttendeeGamesEnvelope(
  response: HttpResponseLike,
  request: RequestDescription,
): ListAttendeeGamesEnvelope {
  const { rows, total } = paginatedEnvelope('games', offeredGameRow, OFFERED_GAME_ROW, response, request);

  return { games: rows, total };
}

/** `POST /api/events/:eventId/attendees/:attendeeId/games`: `{ message, entry }`, in the offered-game shape (#1185). */
export function offeredGameEnvelope(response: HttpResponseLike, request: RequestDescription): OfferedGameWire {
  const entry = isRecord(response.body) ? offeredGameRow(response.body['entry']) : undefined;

  return entry ?? fail(`it carried no 'entry' that is ${OFFERED_GAME_ROW}`, request, response);
}
