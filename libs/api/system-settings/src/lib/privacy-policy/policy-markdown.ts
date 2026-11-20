import { isTooCostlyToParse, sanitizeMarkdown } from '@bge/content-format';
import { PRIVACY_POLICY_MAX_LENGTH } from './privacy-policy.constants';

/** Why a privacy policy's Markdown can't be kept (#934). */
export type PolicyMarkdownProblem = 'too-long' | 'too-complex' | 'empty';

/**
 * A privacy policy's Markdown as the server keeps it, or why it can't be
 * (#934): a policy file's body and a server admin's replacement alike.
 *
 * CRLF line endings are kept as LF, as a policy file's are read, so the same
 * text sent from Windows is the stored text and changes nothing.
 *
 * The order matters. Markdown longer than {@link PRIVACY_POLICY_MAX_LENGTH}
 * UTF-16 code units is refused before it is sanitized: the sanitizer keeps
 * longer Markdown as plain text with its markup shown, and it could shrink
 * such text under the limit, to be kept with its headings and lists
 * flattened. For the same reason, Markdown the sanitizer would find too
 * costly to parse within the limit, with more runs of emphasis markers than
 * it parses, is refused too. The Markdown is then sanitized, and refused when
 * nothing but whitespace is left.
 */
export function sanitizePolicyMarkdown(markdown: string): { markdown: string } | { problem: PolicyMarkdownProblem } {
  const lf = markdown.replaceAll('\r\n', '\n');
  if (lf.length > PRIVACY_POLICY_MAX_LENGTH) {
    return { problem: 'too-long' };
  }

  if (isTooCostlyToParse(lf)) {
    return { problem: 'too-complex' };
  }

  const sanitized = sanitizeMarkdown(lf);
  if (sanitized.trim() === '') {
    return { problem: 'empty' };
  }

  return { markdown: sanitized };
}
