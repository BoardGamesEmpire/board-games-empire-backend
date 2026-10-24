import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type GameShareSnapshot } from '@bge/database';

/**
 * Domain mutation events for game shares (#810).
 *
 * Payloads carry ROW STATE only; the acting actor, source, and correlationId
 * live in CLS and are read at handle time by `AuditPersistenceListener`, never
 * on the payload. Both events are audited by default.
 */

/**
 * EventEmitter2 names for game shares: the INTERNAL domain-event names (audit
 * and in-process listeners), not webhook wire names.
 */
export enum GameShareEvents {
  Created = 'game.share.created',
  Deleted = 'game.share.deleted',
}

/**
 * Emitted once, after commit, when a game is shared with a user or a household.
 * `after.approvedAt` says whether the share is in effect, or waits for a
 * household owner or admin to approve it.
 */
export class GameShareCreatedEvent extends MutationEvent<GameShareSnapshot> {
  static readonly eventName = GameShareEvents.Created;

  declare readonly before: null;
  declare readonly after: GameShareSnapshot;

  readonly subject = ResourceType.GameShare;
  readonly subjectId: string;

  constructor(after: GameShareSnapshot, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Emitted once, after commit, when a share is removed: by its sharer, or by an
 * owner or admin of the household it was made to.
 */
export class GameShareDeletedEvent extends MutationEvent<GameShareSnapshot> {
  static readonly eventName = GameShareEvents.Deleted;

  declare readonly before: GameShareSnapshot;
  declare readonly after: null;

  readonly subject = ResourceType.GameShare;
  readonly subjectId: string;

  constructor(before: GameShareSnapshot, initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}
