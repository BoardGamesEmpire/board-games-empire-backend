/**
 * Spec helpers for checking that the mappers send decoded text (#716). No app
 * code imports this file.
 */

/** An entity or numeric character reference left in text that should be decoded. */
export const ENTITY_RUN = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;

/** Every string in `value`, collected through its objects and arrays. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }

  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(stringsIn);
  }

  return [];
}
