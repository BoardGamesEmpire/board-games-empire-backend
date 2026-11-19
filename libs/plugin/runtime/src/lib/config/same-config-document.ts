import { isDeepStrictEqual } from 'node:util';

/**
 * Whether a supplied config document is the one a row already holds (#903).
 * Key order is no difference: the stored jsonb keeps none. Sending the
 * document a row holds changes nothing, so the write and its event are
 * skipped.
 */
export function isSameConfigDocument(stored: unknown, supplied: unknown): boolean {
  return isDeepStrictEqual(stored, supplied);
}
