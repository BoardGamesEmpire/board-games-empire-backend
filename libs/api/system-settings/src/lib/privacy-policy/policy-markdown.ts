import { sanitizeMarkdown } from '@bge/content-format';
import { PRIVACY_POLICY_MAX_LENGTH } from './privacy-policy.constants';

/** Why a privacy policy's Markdown can't be kept (#934). */
export type PolicyMarkdownProblem = 'too-long' | 'empty';

/**
 * A privacy policy's Markdown as the server keeps it, or why it can't be
 * (#934): a policy file's body and a server admin's replacement alike.
 *
 * The order matters. Markdown longer than {@link PRIVACY_POLICY_MAX_LENGTH}
 * UTF-16 code units is refused before it is sanitized: the sanitizer keeps
 * longer Markdown as plain text with its markup shown, and it could shrink
 * such text under the limit, to be kept with its headings and lists
 * flattened. The Markdown is then sanitized, and refused when nothing but
 * whitespace is left.
 */
export function sanitizePolicyMarkdown(markdown: string): { markdown: string } | { problem: PolicyMarkdownProblem } {
  if (markdown.length > PRIVACY_POLICY_MAX_LENGTH) {
    return { problem: 'too-long' };
  }

  const sanitized = sanitizeMarkdown(markdown);
  if (sanitized.trim() === '') {
    return { problem: 'empty' };
  }

  return { markdown: sanitized };
}
