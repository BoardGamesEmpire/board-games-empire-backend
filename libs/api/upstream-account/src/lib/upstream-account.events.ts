import { AuditExclude, MutationEvent } from '@bge/actor-context';
import type { UpstreamAccount } from '@bge/database';
import { ResourceType } from '@bge/database';

/**
 * Domain mutation events for upstream accounts (#935).
 *
 * Payloads carry ROW STATE only; the acting user, source, and correlationId
 * live in CLS and are read at handle time by `AuditPersistenceListener`, never
 * on the payload. Both events are audited by default.
 */

/**
 * An upstream account as its mutation events carry it: every column but
 * `createdAt`, which the audit row's own time covers.
 */
export type UpstreamAccountSnapshot = Omit<UpstreamAccount, 'createdAt'>;

/** An upstream account row as its events carry it. */
export function upstreamAccountSnapshot(account: UpstreamAccount): UpstreamAccountSnapshot {
  return {
    id: account.id,
    userId: account.userId,
    upstream: account.upstream,
    externalId: account.externalId,
    displayName: account.displayName,
    profileUrl: account.profileUrl,
    verified: account.verified,
    updatedAt: account.updatedAt,
  };
}

/**
 * The snapshot fields audit rows leave out: the upstream's id for the account
 * and the profile address that carries it. Unlinking deletes both, as the
 * privacy policy says (#935), so an audit row that outlives the account keeps
 * neither. In-process listeners still get them.
 */
const UPSTREAM_ACCOUNT_AUDIT_EXCLUDED = [
  'externalId',
  'profileUrl',
] satisfies readonly (keyof UpstreamAccountSnapshot)[];

/**
 * EventEmitter2 names for upstream accounts: the INTERNAL domain-event names
 * (audit and in-process listeners), not webhook wire names.
 */
export enum UpstreamAccountEvents {
  Linked = 'upstream_account.linked',
  Unlinked = 'upstream_account.unlinked',
}

/** Emitted once, after the write, when a user links an upstream account. */
@AuditExclude(UPSTREAM_ACCOUNT_AUDIT_EXCLUDED)
export class UpstreamAccountLinkedEvent extends MutationEvent<UpstreamAccountSnapshot> {
  static readonly eventName = UpstreamAccountEvents.Linked;
  declare readonly before: null;
  declare readonly after: UpstreamAccountSnapshot;
  readonly subject = ResourceType.UpstreamAccount;
  readonly subjectId: string;

  constructor(after: UpstreamAccountSnapshot, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Emitted once, after the delete, when a user unlinks an upstream account. Its
 * sync logs go with it.
 */
@AuditExclude(UPSTREAM_ACCOUNT_AUDIT_EXCLUDED)
export class UpstreamAccountUnlinkedEvent extends MutationEvent<UpstreamAccountSnapshot> {
  static readonly eventName = UpstreamAccountEvents.Unlinked;
  declare readonly before: UpstreamAccountSnapshot;
  declare readonly after: null;
  readonly subject = ResourceType.UpstreamAccount;
  readonly subjectId: string;

  constructor(before: UpstreamAccountSnapshot, initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}
