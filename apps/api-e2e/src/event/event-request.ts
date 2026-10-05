import type { AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
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

export interface EventClient {
  /**
   * `POST /api/events` as `actor`, under a fresh title, with `body` merged
   * over it. Returns the supertest chain, so callers keep `.expect()`.
   */
  createEvent(actor: AuthenticatedActor, body?: Record<string, unknown>): request.Test;

  /** The id of the event `actor` creates, failing the test unless the create answers 201. */
  createdEventId(actor: AuthenticatedActor, body?: Record<string, unknown>): Promise<string>;
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
  };
}
