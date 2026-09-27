import { AuthService } from '@bge/auth';
import { type I18nMessage, type I18nPath, t } from '@bge/i18n';
import { PoliciesGuard } from '@bge/permissions';
import type { BaseClientData } from '@bge/shared';
import { buildWsClientData, type WsRefusalReason } from '@bge/utils';
import { Logger, UseFilters, UseGuards } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayInit } from '@nestjs/websockets';
import { Http } from '@status/codes';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import type { Namespace, Socket } from 'socket.io';
import { WsConnectionRefusal, WsErrorFilter } from '../filters';
import { WsFrameScope, WsFrameScopeGuard } from './ws-frame-scope';
import { WsTranslator } from './ws-translator';

/**
 * Namespaces whose connections are already authenticated, so that gateways
 * sharing a namespace do not each authenticate every connection.
 */
const authenticatedNamespaces = new WeakSet<Namespace>();

/** What the client is told for each session `buildWsClientData` refuses. */
const REFUSAL_KEYS: Record<WsRefusalReason, I18nPath> = {
  'no-user': 'errors.auth.session_unresolved',
  anonymous: 'errors.auth.anonymous_not_permitted',
  impersonated: 'errors.auth.impersonated_session',
};

/**
 * A connection the handshake refuses, with the catalog key that says why. It
 * becomes a {@link WsConnectionRefusal} once rendered in the handshake's
 * locale.
 */
class HandshakeRefusal extends Error {
  constructor(
    readonly statusCode: number,
    readonly marker: I18nMessage,
  ) {
    super(marker.key);
    this.name = HandshakeRefusal.name;
  }
}

/**
 * Authenticates a gateway's connections at the handshake, runs each of their
 * frames as the connection's actor, and answers every refusal in the #426
 * envelope.
 *
 * The connection is authenticated in namespace middleware, which socket.io
 * runs before it accepts the connection. Nest does not await
 * `handleConnection`, so authenticating there left a window in which a
 * client's first frames ran with no actor (#427). A client cannot send a frame
 * before it is accepted, so the middleware leaves no window. A refusal reaches
 * the client as its `connect_error`, with the envelope as its `data`.
 *
 * The middleware also resolves the connection's locale, which every frame's
 * scope then carries (#180). A refusal renders in the handshake's
 * `Accept-Language` alone, since there is no user to consult yet.
 *
 * Each frame then runs inside its connection's actor scope with that actor's
 * abilities primed ({@link WsFrameScope}), so guards, the handler and the
 * exception filter read the actor as they do over HTTP (#498).
 *
 * The guards and filter are bound here, not on each gateway: no app-wide
 * enhancer runs on a gateway message, so a gateway that left them out would
 * go on serving a revoked session, ignore `@CheckPolicies`, and answer in
 * Nest's default shape, and nothing would fail. Nest reads a class's enhancers
 * from its parents too. `AuthGuard` comes first, so a frame whose session has
 * ended is refused before its abilities are looked up, and the scope guard
 * primes them before `PoliciesGuard` reads them.
 */
@UseGuards(AuthGuard, WsFrameScopeGuard, PoliciesGuard)
@UseFilters(WsErrorFilter)
export abstract class AuthenticatedGateway implements OnGatewayInit, OnGatewayConnection {
  protected abstract readonly logger: Logger;

  constructor(
    protected readonly authService: AuthService,
    private readonly frameScope: WsFrameScope,
    protected readonly translator: WsTranslator,
  ) {}

  afterInit(namespace: Namespace): void {
    if (authenticatedNamespaces.has(namespace)) {
      return;
    }

    authenticatedNamespaces.add(namespace);
    namespace.use((client, next) => {
      void this.admit(client).then(next);
    });
  }

  /**
   * Closes a connection the handshake middleware never authenticated, which
   * happens only when a subclass overrides `afterInit` without calling the
   * base's. Left open, it would hear everything the namespace broadcasts.
   */
  handleConnection(client: Socket): void {
    const { userId, correlationId, actor } = client.data as Partial<BaseClientData>;
    if (!actor) {
      this.logger.error(`WS connection was never authenticated: socketId=${client.id}`);
      client.disconnect(true);
      return;
    }

    this.logger.log(`WS connected: socketId=${client.id} userId=${userId} correlationId=${correlationId}`);
  }

  /**
   * Resolves once the connection is authenticated, or with what it is refused
   * with. Never rejects, since neither the locale lookup nor the rendering of a
   * refusal throws, so the middleware always answers the connection.
   */
  private async admit(client: Socket): Promise<WsConnectionRefusal | undefined> {
    try {
      await this.authenticate(client);
      return undefined;
    } catch (error) {
      return this.refusalFor(client, error);
    }
  }

  private async authenticate(client: Socket): Promise<void> {
    const token = client.handshake?.auth?.token;
    this.logger.log(`WS connection attempt: socketId=${client.id} token=${token ? 'present' : 'absent'}`);

    if (!token) {
      this.logger.warn(`Unauthorized WS connection attempt: socketId=${client.id}`);
      throw new HandshakeRefusal(Http.Unauthorized, t('errors.auth.no_token'));
    }

    const session = await this.authService.getSessionFromToken(token);
    if (!this.authService.isValidSession(session)) {
      this.logger.warn(`Invalid session for WS connection: socketId=${client.id}`);
      throw new HandshakeRefusal(Http.Unauthorized, t('errors.auth.session_invalid'));
    }

    // The refusal reason comes back discriminated so the log and the
    // client-facing error both name the actual rule (#408) — an impersonated
    // session and an anonymous one are not interchangeable.
    const outcome = buildWsClientData(session, client.handshake.headers);
    if (!outcome.ok) {
      const detail = outcome.detail ? ` ${outcome.detail}` : '';
      this.logger.warn(`WS connection refused (${outcome.reason}): socketId=${client.id}${detail}`);
      throw new HandshakeRefusal(Http.Forbidden, t(REFUSAL_KEYS[outcome.reason]));
    }

    const locale = await this.translator.localeOf(client, outcome.data.userId);
    client.data = { ...outcome.data, locale } satisfies BaseClientData;
    this.frameScope.bind(client);

    client.onAny((event, ...args) => {
      this.logger.debug(`[RAW EVENT] event=${event} args=${JSON.stringify(args)}`);
    });
  }

  /**
   * A refusal goes to the client rendered in the handshake's locale. Anything
   * else means the session could not be checked at all (the database or Redis
   * briefly down): it is logged, and the client is refused with a 500 that
   * says nothing about why. Like Nest's own 500 over HTTP, that one stays
   * English.
   */
  private async refusalFor(client: Socket, error: unknown): Promise<WsConnectionRefusal> {
    if (error instanceof HandshakeRefusal) {
      const locale = await this.translator.localeOf(client);

      return new WsConnectionRefusal(error.statusCode, this.translator.translate(locale, error.marker));
    }

    this.logger.error(`WS connection failed: socketId=${client.id}`, error);
    return new WsConnectionRefusal(Http.InternalServerError, 'Internal server error');
  }
}
