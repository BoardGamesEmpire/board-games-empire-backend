import { DatabaseService } from '@bge/database';
import { FALLBACK_LOCALE } from '@bge/i18n';
import { lookupTag, parseAcceptLanguage } from '@bge/locale';
import { Injectable } from '@nestjs/common';
import type { PrivacyPolicyDto } from './dto/privacy-policy.dto';
import type { PolicyText } from './policy-file';
import { PrivacyPolicyFilesService } from './privacy-policy-files.service';

/** What a request asks the privacy policy to be in. */
export interface PrivacyPolicyLanguageRequest {
  /** The request's `Accept-Language` header, as sent. */
  acceptLanguage?: string | null;

  /** The language tag the caller asked for by name, tried first. */
  lang?: string;
}

/**
 * The privacy policy (#934). For each language a server admin's row wins over
 * the policy file, which is the fallback; the files are read at boot.
 */
@Injectable()
export class PrivacyPolicyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly files: PrivacyPolicyFilesService,
  ) {}

  /**
   * The policy in the best language the server has it in, from rows and files
   * together: `lang` first, then `Accept-Language` in its order of preference,
   * then English. A regional tag matches its base language, and anything that
   * isn't a language tag matches nothing, so the read never fails on it.
   */
  async read({ acceptLanguage, lang }: PrivacyPolicyLanguageRequest): Promise<PrivacyPolicyDto> {
    const rows = await this.operatorTexts();
    const available = this.availableLanguages(rows);
    const preferred = parseAcceptLanguage(acceptLanguage);
    const language = lookupTag(lang ? [lang, ...preferred] : preferred, available) ?? FALLBACK_LOCALE;

    return toDto(this.text(rows, language), available);
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

  /** Every language the policy can be read in, from rows and files, once each and sorted. */
  private availableLanguages(rows: ReadonlyMap<string, PolicyText>): string[] {
    return [...new Set([...rows.keys(), ...this.files.languages()])].sort();
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
