import { DatabaseService, isPrismaDependentRecordNotFoundError, Prisma } from '@bge/database';
import { CodedHttpException, FALLBACK_LOCALE, LocaleResolutionService, t } from '@bge/i18n';
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

  /** The language a signed-in reader stored as their preference, tried after `lang`. */
  storedLanguage?: string | null;
}

/** What a reader asks the privacy policy to be in, the reader named rather than their stored language. */
export interface PrivacyPolicyReaderRequest extends Omit<PrivacyPolicyLanguageRequest, 'storedLanguage'> {
  /** The signed-in reader whose stored language is tried after `lang`, or null for none. */
  userId: string | null;
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
  'too-complex': () =>
    new CodedHttpException(Http.BadRequest, PrivacyPolicyErrorCode.TooComplex, t('errors.privacy_policy.too_complex')),
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
    private readonly localeResolution: LocaleResolutionService,
  ) {}

  /**
   * The policy a reader is served: {@link read}, with a signed-in reader's
   * stored language read for them. `GET /api/privacy-policy` and a route that
   * shows the policy before an act, such as linking an upstream account
   * (#935), both read it here, so a reader sees the same policy in both. The
   * stored language, not the request's interface language: that is matched
   * against the catalogs, and a policy can exist in a language they don't
   * (#934).
   */
  async readFor({ userId, ...request }: PrivacyPolicyReaderRequest): Promise<PrivacyPolicyDto> {
    const storedLanguage = userId === null ? null : await this.localeResolution.storedLanguage(userId);

    return this.read({ ...request, storedLanguage });
  }

  /**
   * The policy in the best language the server has it in, from rows and files
   * together: `lang` first, then the reader's stored language, then
   * `Accept-Language` in its order of preference, then English. A regional tag matches its base language, and anything that
   * isn't a language tag matches nothing, so the read never fails on it.
   *
   * Anyone can read it, so a read fetches the Markdown of one row at most: the
   * rows' languages decide which language is served, then that language's row,
   * if it has one, is read.
   */
  async read(request: PrivacyPolicyLanguageRequest): Promise<PrivacyPolicyDto> {
    const rowLanguages = await this.rowLanguages(this.db);
    const available = this.availableLanguages(rowLanguages);
    const ranges = [request.lang, request.storedLanguage, ...parseAcceptLanguage(request.acceptLanguage)].filter(
      (range) => range != null,
    );
    const language = lookupTag(ranges, available) ?? FALLBACK_LOCALE;

    const row = rowLanguages.includes(language) ? await this.rowText(language) : null;
    const text = row ?? this.files.get(language);
    if (text) {
      return toDto(text, available);
    }

    // The row was removed between the two reads, and no file gives the
    // language, so it is no longer available: choose again.
    if (rowLanguages.includes(language)) {
      return this.read(request);
    }

    // Every available language has a row or a file, and the boot fails
    // without the fallback language's file, so this is a wiring fault.
    throw new Error(`There is no privacy policy in ${language}: the privacy policy files were not loaded.`);
  }

  /**
   * Replaces the privacy policy in one language with a server admin's
   * Markdown, and answers the policy as it is now served in that language.
   *
   * The Markdown is kept as a policy file's body is
   * ({@link sanitizePolicyMarkdown}). Longer than
   * {@link PRIVACY_POLICY_MAX_LENGTH} UTF-16 code units, it is refused with
   * 400 `PRIVACY_POLICY_TOO_LONG` before it is sanitized. This is the only
   * check of the length: the request's validation would count a character
   * outside the Basic Multilingual Plane once, not twice, and refuse the same
   * rule in a second shape. With more runs of emphasis markers than the
   * sanitizer parses, it is refused with 400 `PRIVACY_POLICY_TOO_COMPLEX`.
   * With nothing but whitespace left once sanitized, it is refused
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
    const write = await this.db.$transaction(async (tx) => {
      const languageTagId = await lockLanguageTag(tx, tag);
      if (languageTagId === null) {
        throw unknownLanguage();
      }

      const stored = await tx.privacyPolicy.findUnique({ where: { languageTagId }, select: SNAPSHOT_SELECT });
      // Writing the same text again would move the row's date, `@updatedAt`,
      // and tell readers the policy changed when nothing they read did.
      if (stored !== null && stored.markdown === sanitized) {
        return { changed: false as const, current: stored, rowLanguages: await this.rowLanguages(tx) };
      }

      const written = await tx.privacyPolicy.upsert({
        where: { languageTagId },
        create: { languageTagId, markdown: sanitized },
        update: { markdown: sanitized },
        select: SNAPSHOT_SELECT,
      });

      // Read after the write, so a first write lists its own language.
      return { before: stored, changed: true as const, current: written, rowLanguages: await this.rowLanguages(tx) };
    });

    if (write.changed) {
      this.eventEmitter.emit(
        PrivacyPolicyReplacedEvent.eventName,
        new PrivacyPolicyReplacedEvent(write.before, write.current, initiatedAt),
      );
    }

    const { current } = write;
    return toDto(
      { language: tag, markdown: current.markdown, source: 'operator', updatedAt: current.updatedAt },
      this.availableLanguages(write.rowLanguages),
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

  /** The languages the server admins' rows are in, as `client` reads them: a read's, or a write's transaction. */
  private async rowLanguages(client: Prisma.TransactionClient): Promise<string[]> {
    const rows = await client.privacyPolicy.findMany({ select: { languageTag: { select: { tag: true } } } });

    return rows.map(({ languageTag: { tag } }) => tag);
  }

  /** The server admin's row in a language, as a policy text, or null when there is none. */
  private async rowText(language: string): Promise<PolicyText | null> {
    const row = await this.db.privacyPolicy.findFirst({
      where: { languageTag: { tag: language } },
      select: { markdown: true, updatedAt: true },
    });

    return row && { language, markdown: row.markdown, source: 'operator', updatedAt: row.updatedAt };
  }

  /** Every language the policy can be read in, from rows and files, once each and sorted. */
  private availableLanguages(rowLanguages: Iterable<string>): string[] {
    return [...new Set([...rowLanguages, ...this.files.languages()])].sort();
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
