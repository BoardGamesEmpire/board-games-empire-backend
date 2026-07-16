import { DatabaseService } from '@bge/database';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { FALLBACK_LOCALE } from './locale.constants';

/**
 * The set of catalog locales request-time resolution may target, loaded once
 * at boot: `LanguageTag.tag` values flagged `systemSupported` **intersected**
 * with the catalogs `nestjs-i18n` actually loaded from disk.
 *
 * The intersection guards against drift between the two sources of truth
 * (docs/i18n/locale-key-strategy.md): a DB-flagged tag without a shipped
 * catalog would resolve every key to the per-key fallback, silently; a
 * shipped catalog without the DB flag is unreachable. Both directions are
 * warned at boot; resolution only ever yields locales that truly have
 * catalogs.
 *
 * The set changes only via seed/curation, so there is no request-time DB
 * cost and no invalidation — a redeploy (which re-runs boot) picks up
 * changes. Revisit if #149 grows an admin mutation path.
 */
@Injectable()
export class SupportedLocalesService implements OnModuleInit {
  private readonly logger = new Logger(SupportedLocalesService.name);

  private tags: readonly string[] = [FALLBACK_LOCALE];

  constructor(
    private readonly db: DatabaseService,
    private readonly i18n: I18nService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.tags = await this.load();
  }

  /**
   * Catalog locales requests may resolve to. Always non-empty; contains at
   * least {@link FALLBACK_LOCALE}.
   */
  getSupportedTags(): readonly string[] {
    return this.tags;
  }

  private async load(): Promise<readonly string[]> {
    const catalogs = this.i18n.getSupportedLanguages();

    let dbTags: string[];
    try {
      const rows = await this.db.languageTag.findMany({
        where: { systemSupported: true },
        select: { tag: true },
        orderBy: { tag: 'asc' },
      });
      dbTags = rows.map((row) => row.tag);
    } catch (error) {
      this.logger.error(
        `Failed to load systemSupported language tags; locale resolution limited to '${FALLBACK_LOCALE}'`,
        error instanceof Error ? error.stack : undefined,
      );
      return [FALLBACK_LOCALE];
    }

    const catalogSet = new Set(catalogs);
    const supported = dbTags.filter((tag) => catalogSet.has(tag));

    const flaggedWithoutCatalog = dbTags.filter((tag) => !catalogSet.has(tag));
    if (flaggedWithoutCatalog.length > 0) {
      this.logger.warn(
        `LanguageTag(s) flagged systemSupported but shipping no catalog, excluded from resolution: ${flaggedWithoutCatalog.join(', ')}`,
      );
    }

    const dbTagSet = new Set(dbTags);
    const catalogWithoutFlag = catalogs.filter((catalog) => !dbTagSet.has(catalog));
    if (catalogWithoutFlag.length > 0) {
      this.logger.warn(
        `Catalog(s) shipped but not flagged systemSupported, unreachable by resolution: ${catalogWithoutFlag.join(', ')}`,
      );
    }

    if (supported.length === 0) {
      this.logger.warn(
        `No usable supported locales (db: [${dbTags.join(', ')}], catalogs: [${catalogs.join(', ')}]); falling back to '${FALLBACK_LOCALE}'`,
      );
      return [FALLBACK_LOCALE];
    }

    return supported;
  }
}
