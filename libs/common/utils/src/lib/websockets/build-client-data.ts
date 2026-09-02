import type { BaseClientData } from '@bge/shared';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { resolveCorrelationId } from '../correlation.js';
import { sessionImpersonatorId } from '../impersonation.js';

/** Why a session was not permitted to open a WS connection. */
export type WsRefusalReason = 'no-user' | 'anonymous' | 'impersonated';

export interface WsClientDataRefused {
  readonly ok: false;
  readonly reason: WsRefusalReason;
  /** Client-facing. Names the rule, never the principal behind it. */
  readonly message: string;
  /** Log-only. Carries ids that must not be sent to the client. */
  readonly detail?: string;
}

export interface WsClientDataAccepted {
  readonly ok: true;
  readonly data: BaseClientData;
}

export type WsClientDataOutcome = WsClientDataAccepted | WsClientDataRefused;

const refuse = (reason: WsRefusalReason, message: string, detail?: string): WsClientDataRefused => ({
  ok: false,
  reason,
  message,
  detail,
});

/**
 * Builds the `BaseClientData` payload for an authenticated WS connection.
 *
 * Called from gateway base classes during `handleConnection`. Returns a
 * discriminated outcome: `ok: true` with the payload, or `ok: false` with the
 * reason the session is not permitted. The caller is responsible for emitting
 * the error and disconnecting the socket.
 *
 * The reason is discriminated rather than a bare `null` because the refusals
 * are no longer interchangeable (#408) — reporting an impersonated session as
 * "anonymous access not permitted" would make both the log line and the
 * client-facing error untrue.
 *
 * Correlation id is resolved once per connection from the handshake headers
 * (`traceparent` → `x-correlation-id` → generated UUID) and reused for every
 * message in that connection's lifetime.
 */
export function buildWsClientData(
  session: UserSession,
  headers: Record<string, string | string[] | undefined>,
): WsClientDataOutcome {
  const user = session?.user as (UserSession['user'] & { isAnonymous?: boolean }) | undefined;

  if (!user) {
    return refuse('no-user', 'Session could not be resolved');
  }

  /**
   * #408: WS authenticates by bearer token, so an impersonation session's
   * token would otherwise connect and mint `{ kind: 'user', userId: <target> }`
   * — attributing every audit row to the impersonated user with no trace of
   * the admin behind it. Impersonation is blocked at the admin plugin's role
   * map, so this cannot currently fire; it exists so that unblocking
   * impersonation forces a decision about how it is audited.
   *
   * Checked BEFORE the anonymous case, matching both HTTP seams. An
   * impersonated anonymous session is refusable either way, but reporting it
   * as `anonymous` would drop the acting admin's id from the log — the exact
   * untruth the discriminated reason exists to prevent.
   */
  const impersonatorId = sessionImpersonatorId(session);
  if (impersonatorId) {
    return refuse(
      'impersonated',
      // Client-facing: names the rule only. The issue reference and the ids
      // ride along as log-only `detail`.
      'Impersonated sessions are not supported',
      `#408 target=${user.id} impersonatedBy=${impersonatorId}`,
    );
  }

  if (user.isAnonymous) {
    return refuse('anonymous', 'Anonymous access not permitted');
  }

  return {
    ok: true,
    data: {
      userId: user.id,
      actor: { kind: 'user', userId: user.id },
      correlationId: resolveCorrelationId({
        traceparent: headers[TRACEPARENT_HEADER],
        correlationId: headers[CORRELATION_ID_HEADER],
      }),
    },
  };
}
