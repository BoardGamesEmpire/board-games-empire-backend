import type { Prisma } from '../client';

/**
 * The one rule every upstream sync obeys: a sync never undoes what the user
 * said about a copy or a rating change (#1231). The upstream syncs (#1227,
 * #936) write a synced row only where none exists yet for its
 * `(upstreamAccountId, upstreamKey)`, or where the existing row matches this
 * filter: neither edited by the user nor taken back.
 *
 * - `editedByUserAt` is stamped by every user write of the row: an edit, a
 *   take-back or its undo, a restore of a revision, and a removal, the copy
 *   route's or the entry's for each copy it removes. So a copy the user
 *   removed is off-limits to a sync too, and a later sync never makes it
 *   owned again.
 * - `retractedAt` is checked as well, so a row taken back stays out of reach
 *   even should a write ever set it without the stamp.
 *
 * How a sync writes with it, so the check and the write are one statement:
 *
 * - **Create** a row only for a key no row holds: `createMany` with
 *   `skipDuplicates: true`, or a `create` that reads a unique violation on
 *   the key (P2002) as "a row exists" and moves on.
 * - **Update** an existing row with `update` or `updateMany`, this filter in
 *   the `where` beside the key. A row the user edited or took back matches
 *   nothing, and is left as it is.
 * - Never an `upsert` with this filter in its `where`: Prisma runs a native
 *   upsert only when the `where` holds nothing but the unique fields. With
 *   the filter it reads first, and on a row that exists but fails the filter
 *   it falls through to `create`, which throws P2002 rather than skipping.
 */
export const SYNC_MAY_WRITE_COPY: Prisma.CollectionCopyWhereInput = { editedByUserAt: null, retractedAt: null };

/** {@link SYNC_MAY_WRITE_COPY} for a rating change (#1231). */
export const SYNC_MAY_WRITE_RATING_CHANGE: Prisma.CollectionRatingChangeWhereInput = {
  editedByUserAt: null,
  retractedAt: null,
};

/**
 * Whether a sync may write over `row`, a copy or rating change it already
 * holds for the same upstream key: the rule {@link SYNC_MAY_WRITE_COPY} puts
 * in a `where`, for a row already read (#1231).
 */
export function syncMayWrite(row: { editedByUserAt: Date | null; retractedAt: Date | null }): boolean {
  return row.editedByUserAt === null && row.retractedAt === null;
}
