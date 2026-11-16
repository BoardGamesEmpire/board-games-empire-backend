import type { Prisma } from '@bge/database';
import type { ScopeComposer } from '@bge/permissions';
import { readableAttendees, type AttendeeSummary } from '../attendee/attendee-summary';
import { PLATFORM_GAME_SUMMARY_SELECT } from '../constants/platform-game-summary.constant';

/**
 * A lineup game in the one shape every route that serves one uses (#799): the
 * date reads' `games`, the lineup read and the direct add. Two shapes for one
 * row drift apart a field at a time (#558).
 *
 * The supplier's attendee is not in this select. A nested select carries no
 * read ceiling, so it is read on its own: see {@link withSuppliers}.
 */
export const LINEUP_GAME_SELECT = {
  id: true,
  occurrenceId: true,
  platformGameId: true,
  role: true,
  sortOrder: true,
  notes: true,
  maxPlayTime: true,
  nominationId: true,
  addedById: true,
  platformGame: { select: PLATFORM_GAME_SUMMARY_SELECT },
  suppliedBy: { select: { id: true, attendeeId: true } },
} as const satisfies Prisma.EventGameSelect;

export type LineupGameRow = Prisma.EventGameGetPayload<{ select: typeof LINEUP_GAME_SELECT }>;

/** A lineup game with its supplier's attendee, `null` where the actor can't read them. */
export type LineupGame = Omit<LineupGameRow, 'suppliedBy'> & {
  suppliedBy: LineupGameRow['suppliedBy'] & { attendee: AttendeeSummary | null };
};

/**
 * The rows with each supplier's attendee named, read once for all of them
 * under the attendee read ceiling (#799). An attendee the actor can't read is
 * `null` as a whole; one who left the event is still named. `db` may be a
 * write's transaction, so the read runs before its commit.
 */
export async function withSuppliers(
  db: Prisma.TransactionClient,
  scopeComposer: ScopeComposer,
  rows: readonly LineupGameRow[],
): Promise<LineupGame[]> {
  const attendees = await readableAttendees(
    db,
    scopeComposer,
    rows.map(({ suppliedBy }) => suppliedBy.attendeeId),
  );

  return rows.map((row) => ({
    ...row,
    suppliedBy: { ...row.suppliedBy, attendee: attendees.get(row.suppliedBy.attendeeId) ?? null },
  }));
}

/**
 * The row as {@link LINEUP_GAME_SELECT} reads it, from a row read with more
 * top-level columns than that, such as a write's answer. The keys are the
 * select's own, so a key added to it is kept here too. A nested select is
 * passed on as read, so the write must read it with the select's.
 */
export function toLineupGameRow(row: LineupGameRow & Record<string, unknown>): LineupGameRow {
  return Object.fromEntries(
    Object.keys(LINEUP_GAME_SELECT).map((key) => [key, row[key as keyof LineupGameRow]]),
  ) as LineupGameRow;
}

/**
 * A lineup game as a grant check judges it, on whichever of its two parents
 * it hangs off: the date, through the date's event, or the event itself, with
 * the event's household for the household-bound grants. The direct add checks
 * its create on it, and the removal its delete (#769), so both grants see one
 * shape.
 */
export function lineupGameSubject(eventId: string, householdId: string | null, occurrenceId: string | null) {
  return occurrenceId
    ? {
        eventId: null,
        occurrenceId,
        event: null,
        occurrence: { id: occurrenceId, eventId, event: { householdId } },
      }
    : { eventId, occurrenceId: null, event: { householdId }, occurrence: null };
}
