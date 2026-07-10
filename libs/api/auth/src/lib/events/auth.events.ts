import { AuditExclude, MutationEvent } from '@bge/actor-context';
import { ResourceType, type User } from '@bge/database';
import { AuthEvent } from '../constants';

/**
 * Domain mutation events for the auth aggregate (#57 emit-site migration).
 *
 * Payloads carry ROW STATE (before/after snapshots) plus listener-facing
 * context; the acting actor, source, and correlationId live in CLS and are
 * read at handle time — never on the payload. Audited by default.
 */

type UserCreatedSnapshot = Readonly<Pick<User, 'id' | 'username' | 'email' | 'isAnonymous'>>;

/**
 * Emitted by the better-auth `user.create.after` database hook once a User
 * row exists. The snapshot is deliberately minimal — listeners that need
 * more (profile provisioning, etc.) fetch the row by `subjectId`.
 *
 * `email` stays on the in-process payload but is stripped from persisted
 * audit snapshots (registration PII posture).
 */
@AuditExclude(['email'] satisfies readonly (keyof User & string)[])
export class UserCreatedEvent extends MutationEvent<User> {
  static readonly eventName = AuthEvent.UserCreated;

  declare readonly before: null;
  declare readonly after: UserCreatedSnapshot;

  readonly subject = ResourceType.User;
  readonly subjectId: string;

  constructor(after: UserCreatedSnapshot, initiatedAt: Date) {
    super(null, after, initiatedAt);
    this.subjectId = after.id;
  }
}
