import { MutationEvent } from '@bge/actor-context';
import type { PrivacyPolicy } from '@bge/database';
import { ResourceType } from '@bge/database';

/**
 * Domain mutation events for the operator's privacy policy (#934).
 *
 * Payloads carry ROW STATE only; the acting server admin, source, and
 * correlationId live in CLS and are read at handle time by
 * `AuditPersistenceListener`, never on the payload. Both events are audited by
 * default.
 */

/**
 * The operator's privacy policy in one language, as its mutation events carry
 * it: every column but `createdAt`, which the audit row's own time covers.
 */
export type PrivacyPolicySnapshot = Pick<PrivacyPolicy, 'id' | 'languageTagId' | 'markdown' | 'updatedAt'>;

/**
 * EventEmitter2 names for the privacy policy: the INTERNAL domain-event names
 * (audit and in-process listeners), not webhook wire names.
 */
export enum PrivacyPolicyEvents {
  Replaced = 'privacy_policy.replaced',
  Removed = 'privacy_policy.removed',
}

/**
 * Emitted once, after commit, when a server admin writes the privacy policy
 * in a language. `before` is the text it replaced, or null when the language
 * had none of the operator's, so the first write audits as a create and every
 * later one as an update.
 */
export class PrivacyPolicyReplacedEvent extends MutationEvent<PrivacyPolicySnapshot> {
  static readonly eventName = PrivacyPolicyEvents.Replaced;
  declare readonly before: PrivacyPolicySnapshot | null;
  declare readonly after: PrivacyPolicySnapshot;
  readonly subject = ResourceType.PrivacyPolicy;
  readonly subjectId: string;

  constructor(before: PrivacyPolicySnapshot | null, after: PrivacyPolicySnapshot, initiatedAt: Date) {
    super(before, after, initiatedAt);
    this.subjectId = after.id;
  }
}

/**
 * Emitted once, after commit, when a server admin removes the privacy policy
 * in a language, so the policy file for it, if there is one, is served again.
 */
export class PrivacyPolicyRemovedEvent extends MutationEvent<PrivacyPolicySnapshot> {
  static readonly eventName = PrivacyPolicyEvents.Removed;
  declare readonly before: PrivacyPolicySnapshot;
  declare readonly after: null;
  readonly subject = ResourceType.PrivacyPolicy;
  readonly subjectId: string;

  constructor(before: PrivacyPolicySnapshot, initiatedAt: Date) {
    super(before, null, initiatedAt);
    this.subjectId = before.id;
  }
}
