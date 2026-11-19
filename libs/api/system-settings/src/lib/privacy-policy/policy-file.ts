import { isStandardPrivacyPolicy, readPolicyFile } from '@bge/i18n';
import { canonicalizeTag } from '@bge/locale';
import { DateTime } from 'luxon';
import * as path from 'node:path';
import type { PolicyMarkdownProblem } from './policy-markdown';
import { sanitizePolicyMarkdown } from './policy-markdown';
import type { PrivacyPolicySource } from './privacy-policy.constants';

/** The extension of a privacy policy file, which is named `<language tag>.md` (#934). */
export const POLICY_FILE_EXTENSION = '.md';

/** A privacy policy's text in one language, ready to serve (#934). */
export interface PolicyText {
  /** The canonical language tag the text is written in. */
  language: string;

  /** The text, sanitized as every Markdown the server stores is. */
  markdown: string;

  /** Whether it is the standard privacy policy, as shipped, or the operator's. */
  source: PrivacyPolicySource;

  /** The day the text last changed, at midnight UTC. */
  updatedAt: Date;
}

/** Why a policy file can't be served (#934). */
export type PolicyFileProblem = { problem: 'not-a-language-tag' | 'no-valid-date' | PolicyMarkdownProblem };

/**
 * The canonical language tag a policy file's name gives, or null when the
 * name, less its extension, is not a language tag (#934).
 */
export function policyFileLanguage(fileName: string): string | null {
  return canonicalizeTag(path.basename(fileName, POLICY_FILE_EXTENSION));
}

/**
 * Reads one privacy policy file (#934). The name is `<language tag>.md`, and
 * the text starts with front matter giving only the date it last changed, as
 * {@link readPolicyFile} reads it: a byte order mark and CRLF line endings
 * read as a Unix editor would save them, and the blank lines between the
 * front matter and the text are dropped. The body is
 * kept as a server admin's Markdown is ({@link sanitizePolicyMarkdown}):
 * limited in length before it is sanitized, and refused when sanitizing
 * leaves nothing but whitespace. A file whose hash is pinned for its language
 * and date is the standard privacy policy; any other is the operator's.
 */
export function parsePolicyFile(fileName: string, bytes: Buffer): PolicyText | PolicyFileProblem {
  const language = policyFileLanguage(fileName);
  if (!language) {
    return { problem: 'not-a-language-tag' };
  }

  const file = readPolicyFile(bytes);
  const updated = file ? DateTime.fromISO(file.updated, { zone: 'utc' }) : undefined;
  if (!file || !updated?.isValid) {
    return { problem: 'no-valid-date' };
  }

  const kept = sanitizePolicyMarkdown(file.body);
  if ('problem' in kept) {
    return { problem: kept.problem };
  }

  return {
    language,
    markdown: kept.markdown,
    source: isStandardPrivacyPolicy(language, file) ? 'standard' : 'operator',
    updatedAt: updated.toJSDate(),
  };
}
