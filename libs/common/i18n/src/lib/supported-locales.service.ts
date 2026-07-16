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
 * catalogs. A missing catalog for {@link FALLBACK_LOCALE} itself fails the
 * boot — that is broken asset wiring (#139), and every degraded path here
 * depends on the fallback being renderable.
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
    // Case-insensitive membership, matching @bge/locale's lookup semantics —
    // a casing mismatch between a catalog folder and the canonical DB tag
    // must not silently drop the locale (macOS's case-insensitive filesystem
    // would mask exact-match bugs in dev that only surface on Linux).
    const catalogByLower = new Map(catalogs.map((catalog) => [catalog.toLowerCase(), catalog]));

    // Every degraded path below returns [FALLBACK_LOCALE], and nestjs-i18n
    // renders raw keys for any locale without a catalog — if the fallback
    // catalog itself is missing, nothing in the app can translate. That is
    // an asset-wiring defect (#139), not runtime drift: fail the boot.
    if (!catalogByLower.has(FALLBACK_LOCALE.toLowerCase())) {
      throw new Error(
        `Fallback locale '${FALLBACK_LOCALE}' has no loaded catalog (loaded: [${catalogs.join(', ')}]); ` +
          `is the i18n assets glob wired for this app (#139)?`,
      );
    }

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

    // The supported set keeps the DB (canonical) casing — it is what
    // resolution returns and what the catalog folders are named after.
    const supported = dbTags.filter((tag) => catalogByLower.has(tag.toLowerCase()));

    const flaggedWithoutCatalog = dbTags.filter((tag) => !catalogByLower.has(tag.toLowerCase()));
    if (flaggedWithoutCatalog.length > 0) {
      this.logger.warn(
        `LanguageTag(s) flagged systemSupported but shipping no catalog, excluded from resolution: ${flaggedWithoutCatalog.join(', ')}`,
      );
    }

    const dbTagsLower = new Set(dbTags.map((tag) => tag.toLowerCase()));
    const catalogWithoutFlag = catalogs.filter((catalog) => !dbTagsLower.has(catalog.toLowerCase()));
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
