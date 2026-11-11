import type { AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { eventEnvelope } from './event-wire';

/**
 * Request construction shared by the event e2e specs. Request BUILDING lives
 * here; response PARSING lives in `event-wire.ts`, the split the feedback
 * specs make.
 *
 * Three suites create their events through the same route, and their copies
 * of the helper had already diverged: one took no body, and one was built on
 * a create that asserts nothing. Extracted when the third copy arrived (#558).
 */

export const EVENTS_PATH = '/api/events';

/** `GET /api/events/browse`: the upcoming events the acting user can read but doesn't attend (#962). */
export const BROWSE_PATH = `${EVENTS_PATH}/browse`;

/** `GET /api/households/:householdId/events`: a household's upcoming events (#506). */
export const householdEventsPath = (householdId: string) => `/api/households/${householdId}/events`;

/** `/api/events/:eventId/attendees`: the route an event's attendees are listed and added on. */
export const attendeesPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/attendees`;

/** `/api/events/:eventId/offered-games`: every game an event's attendees offer (#1187). */
export const offeredGamesPath = (eventId: string) => `${EVENTS_PATH}/${eventId}/offered-games`;

/** `/api/events/:eventId/attendees/:attendeeId/games`: the games one attendee offers, and where they offer one. */
export const attendeeGamesPath = (eventId: string, attendeeId: string) =>
  `${attendeesPath(eventId)}/${attendeeId}/games`;

export interface EventClient {
  /**
   * `POST /api/events` as `actor`, under a fresh title, with `body` merged
   * over it. Returns the supertest chain, so callers keep `.expect()`.
   */
  createEvent(actor: AuthenticatedActor, body?: Record<string, unknown>): request.Test;

  /** The id of the event `actor` creates, failing the test unless the create answers 201. */
  createdEventId(actor: AuthenticatedActor, body?: Record<string, unknown>): Promise<string>;

  /** `GET /api/events/:eventId/attendees` as `caller`, a session or a key, returning the supertest chain. */
  listAttendees(caller: Caller, eventId: string, query?: { page?: number; limit?: number }): request.Test;

  /** `GET /api/events/:eventId/offered-games` as `caller`, with `query` as sent, returning the supertest chain. */
  listOfferedGames(caller: Caller, eventId: string, query?: Record<string, string | number | boolean>): request.Test;
}

export function createEventClient(baseUrl: string): EventClient {
  const createEvent = (actor: AuthenticatedActor, body: Record<string, unknown> = {}) =>
    request(baseUrl)
      .post(EVENTS_PATH)
      .set(actor.headers)
      .send({ title: `e2e event ${randomUUID().slice(0, 8)}`, ...body });

  return {
    createEvent,
    createdEventId: async (actor, body = {}) =>
      eventEnvelope(await createEvent(actor, body).expect(201), 'POST /api/events').id,
    listAttendees: (caller, eventId, query = {}) =>
      request(baseUrl).get(attendeesPath(eventId)).query(query).set(caller.headers),
    listOfferedGames: (caller, eventId, query = {}) =>
      request(baseUrl).get(offeredGamesPath(eventId)).query(query).set(caller.headers),
  };
}
