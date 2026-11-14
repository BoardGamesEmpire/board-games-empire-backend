/**
 * The caps on what a user can store in lists (#1241). Each bounds a request
 * body or a per-user row count, so no one list or user grows without limit.
 */

/** A list's name, in characters. */
export const LIST_MAX_NAME_LENGTH = 100;

/** A list's description, in characters. Markdown, stored as written. */
export const LIST_MAX_DESCRIPTION_LENGTH = 10_000;

/** A list entry's note, in characters. Markdown, stored as written. */
export const LIST_ENTRY_MAX_NOTE_LENGTH = 2_000;

/** Entries on one list. Also the most ids an entry reorder carries. */
export const LIST_MAX_ENTRIES = 1_000;

/** Lists one user holds, the wishlist included. Also the most ids a list reorder carries. */
export const LISTS_MAX_PER_USER = 200;
