import { sanitizeMarkdown } from '@bge/content-format';
import { STANDARD_PRIVACY_POLICY_HASHES } from '@bge/i18n';
import { canonicalizeTag } from '@bge/locale';
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { PRIVACY_POLICY_MAX_LENGTH } from './privacy-policy.constants';

/** The extension of a privacy policy file, which is named `<language tag>.md` (#934). */
export const POLICY_FILE_EXTENSION = '.md';

/** A byte order mark, which an editor may put at the start of a file. */
const BOM = String.fromCodePoint(0xfeff);

/**
 * The front matter a policy file starts with (#934): only the date its text
 * last changed. Line endings are LF by the time it is matched.
 */
const FRONT_MATTER = /^---\nupdated: (\d{4}-\d{2}-\d{2})\n---\n/;

/** Lines holding nothing but spaces or tabs, at the start of the text. */
const LEADING_BLANK_LINES = /^(?:[ \t]*\n)+/;

/** A privacy policy's text in one language, ready to serve (#934). */
export interface PolicyText {
  /** The canonical language tag the text is written in. */
  language: string;

  /** The text, sanitized as every Markdown the server stores is. */
  markdown: string;

  /** Whether it is the standard privacy policy, as shipped, or the operator's. */
  source: 'standard' | 'operator';

  /** The day the text last changed, at midnight UTC. */
  updatedAt: Date;
}

/** Why a policy file can't be served (#934). */
export type PolicyFileProblem = { problem: 'not-a-language-tag' | 'no-valid-date' | 'empty' | 'too-long' };

/**
 * Reads one privacy policy file (#934). The name is `<language tag>.md`, and
 * the text starts with front matter giving only the date it last changed:
 * `---\nupdated: YYYY-MM-DD\n---\n`. A byte order mark and CRLF line endings
 * read as a Unix editor would save them.
 *
 * Blank lines between the front matter and the text are dropped. The body is
 * limited in length before it is sanitized, and refused when sanitizing
 * leaves nothing but whitespace. A file whose bytes match a hash pinned for its
 * language is the standard privacy policy; any other is the operator's.
 */
export function parsePolicyFile(fileName: string, bytes: Buffer): PolicyText | PolicyFileProblem {
  const language = canonicalizeTag(path.basename(fileName, POLICY_FILE_EXTENSION));
  if (!language) {
    return { problem: 'not-a-language-tag' };
  }

  const text = withoutBom(bytes.toString('utf8')).replaceAll('\r\n', '\n');
  const frontMatter = FRONT_MATTER.exec(text);
  const updated = frontMatter ? DateTime.fromISO(frontMatter[1], { zone: 'utc' }) : undefined;
  if (!frontMatter || !updated?.isValid) {
    return { problem: 'no-valid-date' };
  }

  // The blank lines that usually follow the front matter aren't the text's.
  const body = text.slice(frontMatter[0].length).replace(LEADING_BLANK_LINES, '');
  if (body.length > PRIVACY_POLICY_MAX_LENGTH) {
    return { problem: 'too-long' };
  }

  const markdown = sanitizeMarkdown(body);
  if (markdown.trim() === '') {
    return { problem: 'empty' };
  }

  return {
    language,
    markdown,
    source: isStandard(language, bytes) ? 'standard' : 'operator',
    updatedAt: updated.toJSDate(),
  };
}

function withoutBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/** Whether the file's bytes are a standard privacy policy shipped for its language. */
function isStandard(language: string, bytes: Buffer): boolean {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return Object.values(STANDARD_PRIVACY_POLICY_HASHES[language] ?? {}).includes(hash);
}
