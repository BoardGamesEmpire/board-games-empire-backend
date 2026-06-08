import type { BaseClientData } from '@bge/shared';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { resolveCorrelationId } from '../correlation.js';

/**
 * Builds the `BaseClientData` payload for an authenticated WS connection.
 *
 * Called from gateway base classes during `handleConnection`. Returns `null`
 * when the session is not permitted over WS — currently this is anonymous
 * sessions. The caller is responsible for emitting the appropriate error and
 * disconnecting the socket.
 *
 * Correlation id is resolved once per connection from the handshake headers
 * (`traceparent` → `x-correlation-id` → generated UUID) and reused for every
 * message in that connection's lifetime.
 */
export function buildWsClientData(
  session: UserSession,
  headers: Record<string, string | string[] | undefined>,
): BaseClientData | null {
  const user = session?.user as UserSession['user'] & { isAnonymous?: boolean };
  if (!user) {
    return null;
  }

  if (user.isAnonymous) {
    return null;
  }

  const actor = { kind: 'user', userId: user.id } as const;

  return {
    userId: user.id,
    actor,
    correlationId: resolveCorrelationId({
      traceparent: headers[TRACEPARENT_HEADER],
      correlationId: headers[CORRELATION_ID_HEADER],
    }),
  };
}
