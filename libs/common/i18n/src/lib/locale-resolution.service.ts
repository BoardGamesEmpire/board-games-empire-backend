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
 * Preference lookups are cached in-memory per instance for
 * {@link LocaleResolutionService.PREFERENCE_TTL_MS} (size-bounded), so the
 * middleware — which runs on every route — costs one indexed query per user
 * per window rather than per request. A preference change applies within one
 * TTL window on each instance; no cross-instance invalidation is needed for
 * a display-language setting.
 *
 * HTTP calls this from `LocaleResolutionMiddleware`; queue/gRPC seams reuse
 * it in #146/#147 where only a userId is at hand.
 */
@Injectable()
export class LocaleResolutionService {
  /** How long a cached preference may serve before the DB is consulted again. */
  static readonly PREFERENCE_TTL_MS = 60_000;

  private static readonly PREFERENCE_CACHE_MAX_ENTRIES = 10_000;

  private readonly logger = new Logger(LocaleResolutionService.name);

  private readonly preferenceCache = new Map<string, { tag: string | null; expiresAt: number }>();

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
    const cached = this.preferenceCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.tag;
    }

    try {
      const preferences = await this.db.userPreferences.findUnique({
        where: { userId },
        select: { languageTag: { select: { tag: true } } },
      });

      const tag = preferences?.languageTag?.tag ?? null;
      this.cachePreference(userId, tag);
      return tag;
    } catch (error) {
      this.logger.warn(
        `Failed to load language preference for user ${userId}; ` +
          (cached ? 'serving the expired cached preference' : 'falling through to Accept-Language'),
        error instanceof Error ? error.stack : undefined,
      );
      // An expired entry beats losing the preference over a transient DB
      // error; it is not re-armed, so the next request retries the DB.
      return cached?.tag ?? null;
    }
  }

  private cachePreference(userId: string, tag: string | null): void {
    // Insertion-order eviction — a size bound, not strict LRU; the TTL does
    // the real freshness work.
    if (
      this.preferenceCache.size >= LocaleResolutionService.PREFERENCE_CACHE_MAX_ENTRIES &&
      !this.preferenceCache.has(userId)
    ) {
      const oldest = this.preferenceCache.keys().next().value;
      if (oldest !== undefined) {
        this.preferenceCache.delete(oldest);
      }
    }

    this.preferenceCache.delete(userId);
    this.preferenceCache.set(userId, { tag, expiresAt: Date.now() + LocaleResolutionService.PREFERENCE_TTL_MS });
  }
}
