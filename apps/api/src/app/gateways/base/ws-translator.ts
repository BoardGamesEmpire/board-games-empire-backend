import { FALLBACK_LOCALE, type I18nMessage, type I18nTranslations, LocaleResolutionService } from '@bge/i18n';
import type { BaseClientData } from '@bge/shared';
import { Injectable, Logger } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import type { Socket } from 'socket.io';

/**
 * Resolves the locale a WebSocket connection's copy renders in, and renders the
 * copy a gateway sends itself (#180). What a gateway throws is translated by
 * `WsErrorFilter` instead, as the global filters do over HTTP.
 */
@Injectable()
export class WsTranslator {
  private readonly logger = new Logger(WsTranslator.name);

  constructor(
    private readonly localeResolution: LocaleResolutionService,
    private readonly i18n: I18nService<I18nTranslations>,
  ) {}

  /**
   * The connection's locale: `userId`'s stored preference, then the
   * handshake's `Accept-Language`, then the fallback. A refusal passes no
   * `userId`, since the session is being refused and nothing it stores should
   * steer the answer.
   *
   * Never rejects: a connection is not refused over its display language, as
   * an HTTP request is not (`LocaleResolutionMiddleware`).
   */
  async localeOf(client: Socket, userId?: string): Promise<string> {
    try {
      return await this.localeResolution.resolve({
        userId,
        acceptLanguage: client.handshake.headers['accept-language'],
      });
    } catch (error) {
      this.logger.warn(
        `WS locale resolution failed; continuing with '${FALLBACK_LOCALE}': socketId=${client.id}`,
        error instanceof Error ? error.stack : error,
      );
      return FALLBACK_LOCALE;
    }
  }

  /**
   * A `t()` marker, rendered in `locale`.
   *
   * Never throws. A catalog entry that cannot render (a template string-format
   * rejects) is logged, and the client gets the key, as nestjs-i18n answers a
   * key it cannot find. A throw would leave a handshake unanswered, or escape
   * a coordinator stream's callback.
   */
  translate(locale: string, { key, args }: I18nMessage): string {
    try {
      return this.i18n.translate(key, { lang: locale, args });
    } catch (error) {
      this.logger.error(`Could not render '${key}' in '${locale}'`, error instanceof Error ? error.stack : error);
      return key;
    }
  }

  /**
   * A `t()` marker, rendered in the locale the socket's connection resolved.
   * Read from the socket rather than the frame's CLS scope, so it holds in a
   * callback that runs outside the frame, as a coordinator stream's do.
   */
  forClient(client: Socket, marker: I18nMessage): string {
    const { locale } = client.data as Partial<BaseClientData>;

    return this.translate(locale ?? FALLBACK_LOCALE, marker);
  }
}
