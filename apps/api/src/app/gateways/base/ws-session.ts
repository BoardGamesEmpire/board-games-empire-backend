import { AuthService, hasSessionCookie, isBearerAuthorization } from '@bge/auth';
import { t } from '@bge/i18n';
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'socket.io';

/**
 * Where a connection's credential came from. The browser sends a cookie on its
 * own, to any page that opens a socket, so a cookie is the one credential whose
 * handshake must come from a trusted origin.
 */
export type WsCredentialChannel = 'token' | 'authorization' | 'cookie';

/** A connection's credential, as the only headers its session is looked up from. */
export interface WsCredential {
  readonly channel: WsCredentialChannel;
  readonly headers: IncomingHttpHeaders;
}

/** What a bearer token can hold and still be sent as a header: visible ASCII, no spaces. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7E]+$/;

/**
 * The one credential a connection authenticates with: its `auth.token` if it
 * sends one, otherwise its handshake's Bearer `Authorization` header,
 * otherwise its session cookie (#511). A native client can send any of the
 * three, and a browser can send the token or the cookie, since it cannot set
 * a WebSocket's headers. An empty or non-string `auth.token`, as a signed-out
 * client may send, is no token. An `Authorization` header of another scheme,
 * such as the Basic credentials a browser resends to a password-protected
 * host, is not a session credential, and neither is a cookie header with no
 * session cookie in it.
 *
 * The headers returned carry that credential and nothing else. better-auth's
 * bearer plugin passes over a token whose signature fails and reads the
 * cookie instead, so a lookup that saw both would let a made-up token
 * authenticate through the cookie, and skip the origin check a cookie needs.
 * For the same reason, a token string that could not be sent as a header at
 * all is still the credential: its lookup is given nothing, and finds no
 * session.
 */
export function connectionCredential(
  handshake: Pick<Socket['handshake'], 'auth' | 'headers'>,
): WsCredential | undefined {
  const token: unknown = handshake.auth?.token;
  if (typeof token === 'string' && token !== '') {
    return { channel: 'token', headers: HEADER_SAFE_TOKEN.test(token) ? { authorization: `Bearer ${token}` } : {} };
  }

  const { authorization, cookie } = handshake.headers;
  if (isBearerAuthorization(authorization)) {
    return { channel: 'authorization', headers: { authorization } };
  }

  if (hasSessionCookie(cookie)) {
    return { channel: 'cookie', headers: { cookie } };
  }

  return undefined;
}

/**
 * Refuses a frame once its connection's session has ended, so a socket opened
 * on a session that was since signed out or revoked stops being served from
 * its next frame.
 *
 * It looks up the credential the connection authenticated with, read from the
 * handshake again for every frame. The handshake cannot change while the
 * socket is open, so no frame can be checked against any other session. It is
 * never kept on `client.data`, which socket.io hands to the adapter when a
 * connection drops in a way it can recover.
 *
 * The refusal carries the copy the handshake gives the same session. Its 401
 * ends the connection (`WsErrorFilter`).
 */
@Injectable()
export class WsSessionGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const credential = connectionCredential(context.switchToWs().getClient<Socket>().handshake);
    if (!credential) {
      throw sessionEnded();
    }

    const session = await this.authService.getSessionFromHeaders(credential.headers);
    if (!this.authService.isValidSession(session)) {
      throw sessionEnded();
    }

    return true;
  }
}

const sessionEnded = () => new UnauthorizedException(t('errors.auth.session_invalid'));
