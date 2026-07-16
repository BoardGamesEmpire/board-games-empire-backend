import { DatabaseService } from '@bge/database';
import { parseAcceptLanguage, resolveCatalogLocale } from '@bge/locale';
import { Injectable, Logger } from '@nestjs/common';
import { FALLBACK_LOCALE } from './locale.constants';
import { SupportedLocalesService } from './supported-locales.service';

export interface LocaleResolutionInput {
  /**
   * The acting user whose stored preference takes precedence. Any
   * userId-bearing actor qualifies (`user`, `anonymous`, `apiKey` — anonymous
   * users are real User rows and API keys act for their owner).
   */
  readonly userId?: string | null;

  /** Raw `Accept-Language` header value, when the transport has one. */
  readonly acceptLanguage?: string | null;
}

/**
 * Resolves the catalog locale for a request or job: the authenticated user's
 * stored preference (`UserPreferences.languageTagId` → `LanguageTag.tag`),
 * then the `Accept-Language` ranges, then {@link FALLBACK_LOCALE} — a single
 * RFC 4647 §3.4 lookup over the prioritized ranges, so a step only wins when
 * it names a locale we actually ship, and falls through otherwise (an
 * unsupported preference does not snap to the fallback while the header
 * still holds a supported tag).
 *
 * Resolution never throws: a failed preference lookup logs and falls
 * through — the request must not break over its display language.
 *
 * HTTP calls this from `LocaleResolutionMiddleware`; queue/gRPC seams reuse
 * it in #146/#147 where only a userId is at hand.
 */
@Injectable()
export class LocaleResolutionService {
  private readonly logger = new Logger(LocaleResolutionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly supportedLocales: SupportedLocalesService,
  ) {}

  async resolve({ userId, acceptLanguage }: LocaleResolutionInput): Promise<string> {
    const preference = userId ? await this.preferredTag(userId) : null;
    const ranges = preference ? [preference, ...parseAcceptLanguage(acceptLanguage)] : parseAcceptLanguage(acceptLanguage);

    return resolveCatalogLocale(ranges, this.supportedLocales.getSupportedTags(), FALLBACK_LOCALE);
  }

  private async preferredTag(userId: string): Promise<string | null> {
    try {
      const preferences = await this.db.userPreferences.findUnique({
        where: { userId },
        select: { languageTag: { select: { tag: true } } },
      });

      return preferences?.languageTag?.tag ?? null;
    } catch (error) {
      this.logger.warn(
        `Failed to load language preference for user ${userId}; falling through to Accept-Language`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }
}
