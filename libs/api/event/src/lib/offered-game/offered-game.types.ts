import type { ExpansionLink, Prisma } from '@bge/database';
import type { OFFERED_GAME_ATTENDEE_SELECT, OFFERED_GAME_SELECT } from './offered-game.select';

/** An offered entry as {@link OFFERED_GAME_SELECT} reads it. */
export type OfferedGameEntry = Prisma.EventAttendeeGameListGetPayload<{ select: typeof OFFERED_GAME_SELECT }>;

type EntryCollection = OfferedGameEntry['collection'];
type EntryPlatformGame = EntryCollection['platformGame'];

/**
 * What an offered entry supplies the event (#1187): the open nominations that
 * name it and its lineup games still ahead, the two facts the take-back's 409
 * checks. Each is `null` for a caller who can't read that kind of record, so
 * "none that you can see" never reads as "none".
 */
export interface OfferedGameSupplies {
  nominations: number | null;
  lineup: number | null;
}

/**
 * An offered game as the reads and the add serve it (#1185, #1187): the
 * entry, its game's base games, and what it supplies.
 */
export type OfferedGame = Omit<OfferedGameEntry, 'collection'> & {
  collection: Omit<EntryCollection, 'platformGame'> & {
    platformGame: Omit<EntryPlatformGame, 'game'> & {
      game: EntryPlatformGame['game'] & { baseGames: ExpansionLink[] };
    };
  };
  supplies: OfferedGameSupplies;
};

/** An offered game's attendee as {@link OFFERED_GAME_ATTENDEE_SELECT} reads them. */
export type OfferedGameAttendee = Prisma.EventAttendeeGetPayload<{ select: typeof OFFERED_GAME_ATTENDEE_SELECT }>;

/**
 * A row of the offered-games read (#1187): the offered game and its attendee,
 * or `null` for a caller who can't read that attendee. The row's
 * `attendeeId` is there either way.
 */
export type OfferedGameRow = OfferedGame & { attendee: OfferedGameAttendee | null };
