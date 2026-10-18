import type { ContentFormat } from '@bge/database';
import type { Root } from 'mdast';
import { bbcodeTree } from './bbcode';
import { isTooLongToConvert } from './cost';
import { htmlTree } from './html';
import { serializeMarkdown } from './markdown';
import { plainTextToMarkdown, plainTextTree } from './plain-text';
import { sanitizeMarkdown, sanitizeTree } from './sanitize';

/**
 * A DataGateway's free text, such as a game's description, as the Markdown
 * the server stores and sends, converted from the content format the
 * DataGateway declared and then sanitized.
 *
 * A DataGateway that declared no format, or one the server doesn't know, is
 * read as sending plain text. The worst that does to markup is show it as
 * written; a guess at it is how unsafe markup would get through (#714).
 * Text that fails to convert, such as markup nested thousands deep, is read
 * as plain text too, so converting never fails an import or a search. So is
 * markup longer than 20,000 characters, whose conversion would take too long.
 */
export function convertToMarkdown(text: string, format: ContentFormat | null): string;
export function convertToMarkdown<T extends null | undefined>(
  text: string | T,
  format: ContentFormat | null,
): string | T;
export function convertToMarkdown(
  text: string | null | undefined,
  format: ContentFormat | null,
): string | null | undefined {
  if (text === null || text === undefined) {
    return text;
  }

  if (format === 'Markdown') {
    return sanitizeMarkdown(text);
  }

  try {
    const tree = treeOf(text, format);
    sanitizeTree(tree);
    return serializeMarkdown(tree);
  } catch {
    // The tree code recurses, so a deep enough tree exhausts the stack.
    return plainTextToMarkdown(text);
  }
}

function treeOf(text: string, format: Exclude<ContentFormat, 'Markdown'> | null): Root {
  if (isTooLongToConvert(text)) {
    return plainTextTree(text);
  }

  switch (format) {
    case 'Html': {
      return htmlTree(text);
    }

    case 'BBCode': {
      return bbcodeTree(text);
    }

    default: {
      return plainTextTree(text);
    }
  }
}
