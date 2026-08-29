import { Prisma } from '@bge/database';

/**
 * How an event's occurrences are ordered, everywhere they are read.
 *
 * `id` completes the order because `sortOrder` is an `Int @default(0)`: every
 * occurrence nobody has reordered shares a key, so a tie-less sort leaves the
 * database free to return them differently between requests. On the paginated
 * `GET /events/:eventId/occurrences` that lets a row drift across a page
 * boundary; everywhere else it lets two routes disagree about the order of the
 * same event's dates (#372).
 *
 * One exported constant rather than a literal per call site, because the four
 * embedded copies, the paginated read and the availability summary all have to
 * agree — and a comment asking them to agree is not a mechanism. Adding a key
 * here (a `startsAt` ahead of `sortOrder`, say) reaches every reader at once.
 */
export const OCCURRENCE_ORDER = [
  { sortOrder: 'asc' },
  { id: 'asc' },
] satisfies Prisma.EventOccurrenceOrderByWithRelationInput[];
