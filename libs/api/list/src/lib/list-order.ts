import { Prisma } from '@bge/database';

/**
 * Whether `given` names exactly the ids in `held`, each once, in any order
 * (#1241). Both reorders, of a user's lists and of a list's entries, write
 * only when it does: one that doesn't was built from a set that has since
 * changed, so it is refused rather than applied in part.
 */
export function isSameIdSet(held: readonly string[], given: readonly string[]): boolean {
  const heldIds = new Set(held);
  const givenIds = new Set(given);

  return givenIds.size === given.length && givenIds.size === heldIds.size && given.every((id) => heldIds.has(id));
}

/** The rows each reorder renumbers, and the column that keeps it to one owner's. */
const RENUMBERED = {
  lists: { table: '"lists"', owner: '"user_id"' },
  entries: { table: '"list_entries"', owner: '"list_id"' },
} as const;

/**
 * Renumbers the named rows 0..n-1, in the order given, in one statement
 * (#1241): a user's lists (owned by `user_id`) or a list's entries (owned by
 * `list_id`). An update per row inside one interactive transaction is a round
 * trip each, up to the cap. Raw SQL because Prisma has no bulk update that
 * writes a different value to each row. The owner column keeps the statement
 * to that owner's rows whatever ids it is handed, and the count it answers
 * tells the caller whether every id still matched one.
 *
 * `updated_at` takes the app's clock, as Prisma's `@updatedAt` would. It is
 * bound as an ISO string, which carries its zone, so the cast reads it the
 * same in any session time zone. The id and position arrays are cast too, so
 * `unnest` pairs a text with an integer whatever types the driver sends. The
 * table and column names are the constants above, never caller input.
 */
export function renumber(
  rows: keyof typeof RENUMBERED,
  ownerId: string,
  ids: readonly string[],
  now: Date,
): Prisma.Sql {
  const { table, owner } = RENUMBERED[rows];
  const positions = ids.map((_, position) => position);

  return Prisma.sql`
    UPDATE ${Prisma.raw(table)} AS target
    SET "position" = wanted."position", "updated_at" = ${now.toISOString()}::timestamptz
    FROM unnest(${[...ids]}::text[], ${positions}::int[]) AS wanted("id", "position")
    WHERE target."id" = wanted."id"
      AND target.${Prisma.raw(owner)} = ${ownerId}
  `;
}
