import { DatabaseService, isPrismaDependentRecordNotFoundError, Prisma } from '@bge/database';
import { CodedHttpException, FALLBACK_LOCALE, t } from '@bge/i18n';
import { canonicalizeTag, lookupTag, parseAcceptLanguage } from '@bge/locale';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http } from '@status/codes';
import type { PrivacyPolicyDto } from './dto/privacy-policy.dto';
import type { PolicyText } from './policy-file';
import type { PolicyMarkdownProblem } from './policy-markdown';
import { sanitizePolicyMarkdown } from './policy-markdown';
import { PrivacyPolicyFilesService } from './privacy-policy-files.service';
import { PRIVACY_POLICY_MAX_LENGTH, PrivacyPolicyErrorCode } from './privacy-policy.constants';
import type { PrivacyPolicySnapshot } from './privacy-policy.events';
import { PrivacyPolicyRemovedEvent, PrivacyPolicyReplacedEvent } from './privacy-policy.events';

/** What a request asks the privacy policy to be in. */
export interface PrivacyPolicyLanguageRequest {
  /** The request's `Accept-Language` header, as sent. */
  acceptLanguage?: string | null;

  /** The language tag the reader asked for by name, tried first. */
  lang?: string;
}

/** The columns a write reads and returns: its events' snapshot. */
const SNAPSHOT_SELECT = {
  id: true,
  languageTagId: true,
  markdown: true,
  updatedAt: true,
} as const satisfies Prisma.PrivacyPolicySelect;

/** The 400 a server admin's Markdown is refused with, for each problem it can have. */
const MARKDOWN_REFUSALS: Readonly<Record<PolicyMarkdownProblem, () => CodedHttpException>> = {
  empty: () => new CodedHttpException(Http.BadRequest, PrivacyPolicyErrorCode.Empty, t('errors.privacy_policy.empty')),
  'too-long': () =>
    new CodedHttpException(
      Http.BadRequest,
      PrivacyPolicyErrorCode.TooLong,
      t('errors.privacy_policy.too_long', { max: PRIVACY_POLICY_MAX_LENGTH }),
    ),
};

/**
 * The privacy policy (#934). For each language a server admin's row wins over
 * the policy file, which is the fallback; the files are read at boot. A server
 * admin replaces or removes the row for one language, and each write is
 * audited through its event.
 */
@Injectable()
export class PrivacyPolicyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly files: PrivacyPolicyFilesService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * The policy in the best language the server has it in, from rows and files
   * together: `lang` first, then `Accept-Language` in its order of preference,
   * then English. A regional tag matches its base language, and anything that
   * isn't a language tag matches nothing, so the read never fails on it.
   */
  async read({ acceptLanguage, lang }: PrivacyPolicyLanguageRequest): Promise<PrivacyPolicyDto> {
    const rows = await this.operatorTexts();
    const available = this.availableLanguages(rows.keys());
    const preferred = parseAcceptLanguage(acceptLanguage);
    const language = lookupTag(lang ? [lang, ...preferred] : preferred, available) ?? FALLBACK_LOCALE;

    return toDto(this.text(rows, language), available);
  }

  /**
   * Replaces the privacy policy in one language with a server admin's
   * Markdown, and answers the policy as it is now served in that language.
   *
   * The Markdown is kept as a policy file's body is
   * ({@link sanitizePolicyMarkdown}). Longer than
   * {@link PRIVACY_POLICY_MAX_LENGTH} UTF-16 code units, it is refused with
   * 400 `PRIVACY_POLICY_TOO_LONG` before it is sanitized. The request's
   * validation can't be relied on for that: it counts a character outside the
   * Basic Multilingual Plane once, not twice, so it lets some such text
   * through. With nothing but whitespace left once sanitized, it is refused
   * with 400 `PRIVACY_POLICY_EMPTY`. The language tag is canonicalized, so
   * `EN-us` names `en-US`, and must be one the server knows, or the answer is
   * 404 `PRIVACY_POLICY_LANGUAGE_TAG_NOT_FOUND`. It need not be a language the
   * app is translated into.
   *
   * One transaction locks the language tag's row ({@link lockLanguageTag}),
   * reads the text being replaced, and upserts the row. The replaced event,
   * which carries both texts, is announced after commit. Sanitized text equal
   * to the stored text is no change: nothing is written or announced, and the
   * answer keeps the row's date, which a client compares to tell a reader the
   * policy changed.
   */
  async put(languageTag: string, markdown: string): Promise<PrivacyPolicyDto> {
    const kept = sanitizePolicyMarkdown(markdown);
    if ('problem' in kept) {
      throw MARKDOWN_REFUSALS[kept.problem]();
    }

    const sanitized = kept.markdown;
    const tag = canonicalizeTag(languageTag);
    const unknownLanguage = () =>
      new CodedHttpException(
        Http.NotFound,
        PrivacyPolicyErrorCode.LanguageTagNotFound,
        t('errors.privacy_policy.language_tag_not_found', { languageTag: tag ?? languageTag }),
      );

    if (tag === null) {
      throw unknownLanguage();
    }

    const initiatedAt = new Date();
    const { before, changed, current, rowLanguages } = await this.db.$transaction(async (tx) => {
      const languageTagId = await lockLanguageTag(tx, tag);
      if (languageTagId === null) {
        throw unknownLanguage();
      }

      const stored = await tx.privacyPolicy.findUnique({ where: { languageTagId }, select: SNAPSHOT_SELECT });
      // Writing the same text again would move the row's date, `@updatedAt`,
      // and tell readers the policy changed when nothing they read did.
      if (stored !== null && stored.markdown === sanitized) {
        return { before: stored, changed: false, current: stored, rowLanguages: await this.rowLanguages(tx) };
      }

      const written = await tx.privacyPolicy.upsert({
        where: { languageTagId },
        create: { languageTagId, markdown: sanitized },
        update: { markdown: sanitized },
        select: SNAPSHOT_SELECT,
      });

      // Read after the write, so a first write lists its own language.
      return { before: stored, changed: true, current: written, rowLanguages: await this.rowLanguages(tx) };
    });

    if (changed) {
      this.eventEmitter.emit(
        PrivacyPolicyReplacedEvent.eventName,
        new PrivacyPolicyReplacedEvent(before, current, initiatedAt),
      );
    }

    return toDto(
      { language: tag, markdown: current.markdown, source: 'operator', updatedAt: current.updatedAt },
      this.availableLanguages(rowLanguages),
    );
  }

  /**
   * Removes a server admin's privacy policy in one language, so the policy
   * file for it, if there is one, is served again. A language with no row
   * answers 404 `PRIVACY_POLICY_NOT_FOUND`, whether the server knows the
   * language or not: there is nothing to remove either way.
   *
   * The delete runs after the language tag's row lock, which a write takes
   * too ({@link lockLanguageTag}). The removed event, which carries the text
   * removed, is announced after commit.
   */
  async remove(languageTag: string): Promise<void> {
    const tag = canonicalizeTag(languageTag);
    const nothingToRemove = () =>
      new CodedHttpException(
        Http.NotFound,
        PrivacyPolicyErrorCode.NotFound,
        t('errors.privacy_policy.not_found', { languageTag: tag ?? languageTag }),
      );

    if (tag === null) {
      throw nothingToRemove();
    }

    const initiatedAt = new Date();

    let removed: PrivacyPolicySnapshot;
    try {
      removed = await this.db.$transaction(async (tx) => {
        const languageTagId = await lockLanguageTag(tx, tag);
        if (languageTagId === null) {
          throw nothingToRemove();
        }

        return tx.privacyPolicy.delete({ where: { languageTagId }, select: SNAPSHOT_SELECT });
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw nothingToRemove();
      }

      throw error;
    }

    this.eventEmitter.emit(PrivacyPolicyRemovedEvent.eventName, new PrivacyPolicyRemovedEvent(removed, initiatedAt));
  }

  /**
   * The server admins' rows, as policy texts by language tag. The table holds
   * at most one row per language, so it stays small enough to read whole.
   */
  private async operatorTexts(): Promise<ReadonlyMap<string, PolicyText>> {
    const rows = await this.db.privacyPolicy.findMany({
      select: { markdown: true, updatedAt: true, languageTag: { select: { tag: true } } },
    });

    return new Map<string, PolicyText>(
      rows.map(({ languageTag: { tag }, markdown, updatedAt }) => [
        tag,
        { language: tag, markdown, source: 'operator', updatedAt },
      ]),
    );
  }

  /** The languages the server admins' rows are in, as `client` reads them. */
  private async rowLanguages(client: Prisma.TransactionClient): Promise<string[]> {
    const rows = await client.privacyPolicy.findMany({ select: { languageTag: { select: { tag: true } } } });

    return rows.map(({ languageTag: { tag } }) => tag);
  }

  /** Every language the policy can be read in, from rows and files, once each and sorted. */
  private availableLanguages(rowLanguages: Iterable<string>): string[] {
    return [...new Set([...rowLanguages, ...this.files.languages()])].sort();
  }

  /** The text in a language: the row if there is one, otherwise the file. */
  private text(rows: ReadonlyMap<string, PolicyText>, language: string): PolicyText {
    const text = rows.get(language) ?? this.files.get(language);
    // Every available language has a row or a file, and the boot fails
    // without the fallback language's file, so this is a wiring fault.
    if (!text) {
      throw new Error(`There is no privacy policy in ${language}: the privacy policy files were not loaded.`);
    }

    return text;
  }
}

/**
 * Locks the language tag's row `FOR NO KEY UPDATE` until the caller's
 * transaction ends, and answers its id, or null when the server has no such
 * tag (#934).
 *
 * Every write to the privacy policy in a language takes it first, so writes
 * in one language take turns. Without it, under READ COMMITTED, two server
 * admins replacing one language at once would both read the same earlier
 * text, and the later write's event would name as `before` a text it never
 * replaced; a write racing a removal would read, as its `before`, the row
 * being deleted. The tag's row is the one to lock because it exists before
 * the first write in its language, when there is no policy row to lock yet.
 *
 * The mode conflicts with itself and not with the `FOR KEY SHARE` an insert
 * that references the tag takes through its foreign key, so writes elsewhere
 * that name the language don't wait on it. Raw SQL because Prisma exposes no
 * row-locking clause.
 */
async function lockLanguageTag(tx: Prisma.TransactionClient, tag: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM language_tags WHERE tag = ${tag} FOR NO KEY UPDATE`,
  );

  return rows.length > 0 ? rows[0].id : null;
}

/** The answer's five fields, and nothing else the text carries. */
function toDto(text: PolicyText, availableLanguages: string[]): PrivacyPolicyDto {
  return {
    availableLanguages,
    language: text.language,
    markdown: text.markdown,
    source: text.source,
    updatedAt: text.updatedAt.toISOString(),
  };
}
