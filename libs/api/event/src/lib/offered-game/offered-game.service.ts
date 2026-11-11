import { Action, DatabaseService, Prisma, readBaseGameLinks, ResourceType } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import { ACTIVE_NOMINATION_STATUSES, lineupStillAhead } from '../attendee/attendance';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import { OFFERED_GAME_ORDER, OFFERED_GAME_SELECT } from './offered-game.select';
import type { OfferedGame, OfferedGameEntry } from './offered-game.types';

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
   */
  async enrich(entries: readonly OfferedGameEntry[], now: Date): Promise<OfferedGame[]> {
    if (entries.length === 0) {
      return [];
    }

    const entryIds = entries.map((entry) => entry.id);
    const [links, nominations, lineup] = await Promise.all([
      readBaseGameLinks(
        this.db,
        [...new Set(entries.map((entry) => entry.collection.platformGame.game.id))],
        this.scopeComposer.compose(ResourceType.Game, Action.read, { deletedAt: null }),
      ),
      this.tallyNominations(entryIds),
      this.tallyLineup(entryIds, now),
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
    }));
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
