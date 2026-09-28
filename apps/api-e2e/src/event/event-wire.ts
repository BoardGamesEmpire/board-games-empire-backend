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

/** `POST /api/events`, `PATCH /api/events/:id`: `{ message, event }`. */
export function eventEnvelope(response: HttpResponseLike, request: RequestDescription): EventWire {
  const event = isRecord(response.body) ? withId<EventWire>(response.body['event']) : undefined;

  return event ?? fail("it carried no 'event' object with a string id", request, response);
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
