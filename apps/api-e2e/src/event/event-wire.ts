import type { Event, EventAttendee, EventGame } from '@bge/database';
import { envelopeFailure, isRecord, type HttpResponseLike, type RequestDescription, type Wire } from '../support/wire';

/**
 * Fail-loud parsers for the event envelopes, on the pattern
 * `household/household-wire.ts` sets: `supertest` types `response.body` as
 * `any`, so a renamed envelope key would otherwise surface as an assertion
 * against `undefined` that names neither the key nor the change.
 */

export type EventWire = Wire<Event>;
export type EventAttendeeWire = Wire<EventAttendee>;
export type EventGameWire = Wire<EventGame>;

export interface ListEventsEnvelope {
  readonly events: readonly EventWire[];
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
  readonly voters: readonly { readonly attendeeId: string; readonly response: string }[];
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

/**
 * `GET /api/events`: `{ events: [...], pagination }`. The total is checked
 * against the page because both count the same caller-scoped set (#372): a
 * total below the rows on screen means the two disagree about scope.
 */
export function listEventsEnvelope(response: HttpResponseLike, request: RequestDescription): ListEventsEnvelope {
  if (!isRecord(response.body)) {
    return fail('the body is not an object', request, response);
  }

  const events = response.body['events'];
  if (!Array.isArray(events)) {
    return fail("it carried no 'events' array", request, response);
  }

  const rows: EventWire[] = [];
  for (const entry of events) {
    const row = withId<EventWire>(entry);
    if (row === undefined) {
      return fail('one of its events is not an object with a string id', request, response);
    }

    rows.push(row);
  }

  const pagination = response.body['pagination'];
  const total = isRecord(pagination) ? pagination['total'] : undefined;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < rows.length) {
    return fail("it carried no integer 'pagination.total' at least as large as its page", request, response);
  }

  return { events: rows, total };
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
