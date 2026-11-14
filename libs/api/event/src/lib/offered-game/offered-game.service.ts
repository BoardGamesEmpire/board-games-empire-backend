import {
  Action,
  DatabaseService,
  ListKind,
  Prisma,
  readBaseGameLinks,
  readWishlistedPlatformGames,
  ResourceType,
} from '@bge/database';
import { AbilityService, resolveActingUserIdOrNull, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import { ACTIVE_NOMINATION_STATUSES, lineupStillAhead } from '../attendee/attendance';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import { assertEventExists } from '../event-access.helpers';
import type { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';
import { OFFERED_GAME_ATTENDEE_SELECT, OFFERED_GAME_ORDER, OFFERED_GAME_SELECT } from './offered-game.select';
import type { OfferedGame, OfferedGameAttendee, OfferedGameEntry, OfferedGameRow } from './offered-game.types';
import { offeredGamesFilter } from './offered-games.filter';

/**
 * Offered games, in the one shape the reads and the add serve them (#1185,
 * #1187).
 */
@Injectable()
export class OfferedGameService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of every game the event's attendees offer, as far as the caller
   * may read them, with the query's filters ANDed (#1187).
   *
   * - A row is one offered entry: two attendees offering the same game give
   *   two rows.
   * - Entries taken back, and every entry of an attendee removed from
   *   the event, leave both the rows and the total. An attendee answering
   *   Not attending keeps their rows, and the row's attendee says so.
   * - The order is game title, then entry id.
   * - Each row's attendee is read once for the page, under the attendee read
   *   ceiling, and is `null` for a caller who can't read them.
   *
   * The existence probe runs first, so a missing event answers 404 rather
   * than an empty page. As in `getAttendees`, an event deleted between the
   * probe and the read answers its rows.
   */
  async listOfferedGames(eventId: string, query: ListOfferedGamesQueryDto): Promise<PaginatedRows<OfferedGameRow>> {
    await assertEventExists(this.db, eventId);

    const { rows, total } = await this.page(
      { ...NOT_REMOVED, attendee: { is: { eventId, ...NOT_REMOVED } }, AND: offeredGamesFilter(query) },
      query,
      new Date(),
    );
    const attendees = await this.attendeesFor(rows);

    return { rows: rows.map((row) => ({ ...row, attendee: attendees.get(row.attendeeId) ?? null })), total };
  }

  /**
   * One page of the offered games matching `where` that the caller may read,
   * plus the total for the envelope (#1001, #1187).
   *
   * The offered-games read ceiling is composed over `where` at the top level.
   * The rows and the count share one REPEATABLE READ snapshot, so `total`
   * agrees with the rows. The order is {@link OFFERED_GAME_ORDER}. Pages are
   * offsets into a live list, so an entry offered or taken back between
   * requests can shift the rows after it.
   */
  async page(
    where: Prisma.EventAttendeeGameListWhereInput,
    pagination: PaginationQueryDto,
    now: Date,
  ): Promise<PaginatedRows<OfferedGame>> {
    const scoped = this.scopeComposer.compose(ResourceType.EventAttendeeGameList, Action.read, where);

    const [entries, total] = await this.db.$transaction(
      [
        this.db.eventAttendeeGameList.findMany({
          where: scoped,
          select: OFFERED_GAME_SELECT,
          orderBy: OFFERED_GAME_ORDER,
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.eventAttendeeGameList.count({ where: scoped }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: await this.enrich(entries, now), total };
  }

  /**
   * The games each attendee offers, as far as the caller may read them, for
   * the attendee routes' embed (#404, #1187). Entries taken back are left out.
   * Every attendee named has a key, `[]` when they offer nothing the caller
   * can see.
   *
   * The embed used to be an include, which reached anyone who could read
   * attendees whatever their read on offered games. It's a read of its own
   * now, under the offered-games read ceiling. How many games it carries is
   * #404's question; it carries them all.
   */
  async forAttendees(attendeeIds: readonly string[], now: Date): Promise<ReadonlyMap<string, OfferedGame[]>> {
    const byAttendee = new Map(attendeeIds.map((id): [string, OfferedGame[]] => [id, []]));

    if (attendeeIds.length === 0) {
      return byAttendee;
    }

    const entries = await this.db.eventAttendeeGameList.findMany({
      where: this.scopeComposer.compose(ResourceType.EventAttendeeGameList, Action.read, {
        attendeeId: { in: [...attendeeIds] },
        ...NOT_REMOVED,
      }),
      select: OFFERED_GAME_SELECT,
      orderBy: OFFERED_GAME_ORDER,
    });

    for (const game of await this.enrich(entries, now)) {
      byAttendee.get(game.attendeeId)?.push(game);
    }

    return byAttendee;
  }

  /**
   * Each entry with its game's base games and what it supplies, in the
   * order given (#1187).
   *
   * Each fact is a read of its own, at the top level, under its own read
   * ceiling: in the entry's select, Prisma would drop a deny-all ceiling and
   * serve every row (#559).
   *
   * - Base games: the links whose base game is live and the caller could
   *   open, as collection rows read them (#1070). A game offered more than
   *   once is read once.
   * - Supplies: the open nominations naming the entry, and its lineup games
   *   still ahead at `now`. Each is `null` for a caller with no read on that
   *   kind of record at all, and not read.
   * - On wishlist: whether each entry's game is on the acting user's
   *   wishlist, read once for the batch (#1241).
   */
  async enrich(entries: readonly OfferedGameEntry[], now: Date): Promise<OfferedGame[]> {
    if (entries.length === 0) {
      return [];
    }

    const entryIds = entries.map((entry) => entry.id);
    const [links, nominations, lineup, wishlisted] = await Promise.all([
      readBaseGameLinks(
        this.db,
        [...new Set(entries.map((entry) => entry.collection.platformGame.game.id))],
        this.scopeComposer.compose(ResourceType.Game, Action.read, { deletedAt: null }),
      ),
      this.tallyNominations(entryIds),
      this.tallyLineup(entryIds, now),
      this.wishlistedPlatformGames(entries),
    ]);

    return entries.map(({ collection: { platformGame, ...collection }, ...entry }) => ({
      ...entry,
      collection: {
        ...collection,
        platformGame: {
          ...platformGame,
          game: { ...platformGame.game, baseGames: links.get(platformGame.game.id) ?? [] },
        },
      },
      supplies: {
        nominations: nominations === null ? null : (nominations.get(entry.id) ?? 0),
        lineup: lineup === null ? null : (lineup.get(entry.id) ?? 0),
      },
      onWishlist: wishlisted === null ? null : wishlisted.has(platformGame.id),
    }));
  }

  /**
   * The attendees of `games`, keyed by id, as far as the caller may read
   * them: a top-level read under the attendee read ceiling. In the entry's
   * select, a key holding only read on offered games would see the names and
   * avatars it can't read on the attendee routes (#404, #559).
   */
  private async attendeesFor(games: readonly OfferedGame[]): Promise<ReadonlyMap<string, OfferedGameAttendee>> {
    const attendeeIds = [...new Set(games.map((game) => game.attendeeId))];

    if (attendeeIds.length === 0) {
      return new Map();
    }

    const attendees = await this.db.eventAttendee.findMany({
      where: this.scopeComposer.compose(ResourceType.EventAttendee, Action.read, { id: { in: attendeeIds } }),
      select: OFFERED_GAME_ATTENDEE_SELECT,
    });

    return new Map(attendees.map((attendee) => [attendee.id, attendee]));
  }

  /**
   * The platform games among `entries` that are on the acting user's wishlist
   * (#1241), or null for an actor with no wishlist they can read: no acting
   * user (plugin, system, external actors), no list read access (an anonymous
   * user, a key without a list grant), or a list read that doesn't reach the
   * wishlist (a key whose list grant is pinned to one custom list). Null, not
   * an empty set, because "not on your wishlist" would claim a wishlist was
   * checked.
   *
   * The wishlist read is composed under the actor's list ceiling in its own
   * top-level query, so a deny-all fails closed and answers null. The access
   * check up front only saves that query when the answer is already known.
   */
  private async wishlistedPlatformGames(entries: readonly OfferedGameEntry[]): Promise<ReadonlySet<string> | null> {
    const userId = resolveActingUserIdOrNull(this.abilityService);

    if (userId === null || !this.canRead(ResourceType.List)) {
      return null;
    }

    return readWishlistedPlatformGames(
      this.db,
      entries.map(({ collection: { platformGame } }) => ({ id: platformGame.id, gameId: platformGame.game.id })),
      this.scopeComposer.compose(ResourceType.List, Action.read, { userId, kind: ListKind.Wishlist }),
    );
  }

  /** The open nominations naming each entry, or null for a caller who can't read nominations. */
  private async tallyNominations(entryIds: readonly string[]): Promise<ReadonlyMap<string, number> | null> {
    if (!this.canRead(ResourceType.EventGameNomination)) {
      return null;
    }

    // `findMany`, not `groupBy`: the CASL extension's deny-all repair is
    // proven for `findMany` only.
    const rows = await this.db.eventGameNomination.findMany({
      where: this.scopeComposer.compose(ResourceType.EventGameNomination, Action.read, {
        suppliedFromId: { in: [...entryIds] },
        status: { in: ACTIVE_NOMINATION_STATUSES },
      }),
      select: { suppliedFromId: true },
    });

    return tally(rows.map((row) => row.suppliedFromId));
  }

  /** Each entry's lineup games still ahead at `now`, or null for a caller who can't read the lineup. */
  private async tallyLineup(entryIds: readonly string[], now: Date): Promise<ReadonlyMap<string, number> | null> {
    if (!this.canRead(ResourceType.EventGame)) {
      return null;
    }

    const rows = await this.db.eventGame.findMany({
      where: this.scopeComposer.compose(ResourceType.EventGame, Action.read, {
        suppliedById: { in: [...entryIds] },
        ...lineupStillAhead(now),
      }),
      select: { suppliedById: true },
    });

    return tally(rows.map((row) => row.suppliedById));
  }

  /**
   * Whether the caller can read any record of `resourceType`. With none, a
   * ceiling is a deny-all and a count would answer 0, which says "nothing"
   * where the truth is "not yours to know".
   */
  private canRead(resourceType: ResourceType): boolean {
    return this.abilityService.getCurrentAccess([resourceType])[resourceType]?.[Action.read] !== 'none';
  }
}

/** How many times each id appears. */
function tally(ids: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return counts;
}
