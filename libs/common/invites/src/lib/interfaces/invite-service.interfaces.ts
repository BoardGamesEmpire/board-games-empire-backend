import type { InviteType, Prisma } from '@bge/database';
import type {
  InviteAcceptedEvent,
  InviteApprovedEvent,
  InviteCreatedEvent,
  InviteDeclinedEvent,
  InviteExpiredEvent,
  InviteRevokedEvent,
  InviteWithdrawnEvent,
} from '../events/invite.events';
import type { InviteContextView, InvitePartyView } from '../read-shapes';

/**
 * Everything `createWithin` needs, and nothing it can infer.
 *
 * `inviterId` is passed rather than read from CLS so the seam is usable from a
 * worker or a system-actor sweep as well as a request. It is the consumer's
 * acting user; the lib binds the row to it as inviter.
 *
 * `roleId` is opaque here. Which roles are assignable in which context is the
 * consumer's rule (#162 validates against the household's assignable set);
 * the lib stores what it is given.
 */
export interface CreateInviteParams {
  readonly type: InviteType;
  readonly inviterId: string;
  /** The invitee's user id, when they are a registered user. */
  readonly inviteeId?: string | null;
  /** Where to reach an invitee, registered or not. Trimmed and lower-cased before storage. */
  readonly inviteeEmail?: string | null;
  readonly inviteeName?: string | null;
  /** Required when `type` is `Household`. */
  readonly householdId?: string | null;
  /** Required when `type` is `Event`. */
  readonly eventId?: string | null;
  readonly roleId?: string | null;
  readonly message?: string | null;
  readonly metadata?: Prisma.InputJsonValue;
  /** Opens the invite as `AwaitingApproval` instead of `Pending` (#166). */
  readonly needsApproval?: boolean;
  /**
   * Marks an invite that a block or the invitee's preference refused, where
   * refusing it outright would tell the inviter so (#278). It is stored and
   * answered like any other; only what delivers invites reads the mark. Only
   * an invite by address can carry it: `createWithin` refuses it beside an
   * `inviteeId`, since that invitee would reach the invite by id.
   */
  readonly withheld?: boolean;
  /** Defaults to `DEFAULT_INVITE_TTL_MS` after now. Must be in the future. */
  readonly expiresAt?: Date;
}

/**
 * How a party names the invite they are acting on.
 *
 * An invite bound to a user is reached by `inviteId`; an email-only invite,
 * which has no `inviteeId` to bind to, is reached by the `token` its link
 * carries (#161). Either form reaches a user-bound invite. An email-only one
 * is reached by its token, or by its id when the consumer vouches for its
 * address ({@link InvitePartyLookup.vouchedEmail}, #163).
 */
export type InviteTarget = { readonly inviteId: string } | { readonly token: string };

/** A party naming an invite of theirs: the read, and accept or decline. */
export interface InvitePartyLookup {
  readonly target: InviteTarget;
  readonly actingUserId: string;
  /**
   * An address the consumer vouches belongs to the acting user (#163). With
   * it, an invite by address to that address is the actor's to answer by id,
   * as its link would make it, unless it is withheld (#278). Which addresses
   * deserve that is the consumer's rule; the household routes vouch only for
   * a verified one. Trimmed and lower-cased before it is compared.
   */
  readonly vouchedEmail?: string | null;
}

/** Accept or decline: the invitee acts. */
export type RespondToInviteParams = InvitePartyLookup;

/** Withdraw: the inviter acts. */
export interface WithdrawInviteParams {
  readonly inviteId: string;
  readonly actingUserId: string;
}

/**
 * The context a consumer's authority covers: the household or event it
 * asserted the caller's role in. A context transition binds its read to it,
 * so an invite id from another context is a miss, and a bulk revoke closes
 * everything outstanding into it. A `System` or `Campaign` invite names
 * neither; that variant arrives with the first route that needs it.
 */
export type InviteContextScope = { readonly householdId: string } | { readonly eventId: string };

/** The invite types whose rows name a context. */
export type ContextualInviteType = typeof InviteType.Household | typeof InviteType.Event;

/** The context an invite of `Type` belongs to, as the scope a context transition binds to. */
export type InviteScopeOf<Type extends ContextualInviteType> = Type extends typeof InviteType.Household
  ? { readonly householdId: string }
  : { readonly eventId: string };

/**
 * Revoke: a context authority acts. The lib binds nothing to the actor here;
 * the consumer has asserted the owner or admin role before calling, which is
 * the one authority check the lib never makes (#161). What the lib does bind
 * is the context: `scope` names the household or event that assertion was
 * about, and the read carries it, so an invite id from another context meets
 * a 404 as a stranger's does, not a transition the caller was never
 * authorized to make.
 */
export interface RevokeInviteParams {
  readonly inviteId: string;
  readonly scope: InviteContextScope;
}

/**
 * Approve: an approver moves an `AwaitingApproval` invite to `Pending`. Bound
 * to `scope` as a revoke is: the consumer asserted the approver's authority
 * over that context, and the lib confirms the invite is in it.
 */
export interface ApproveInviteParams {
  readonly inviteId: string;
  readonly approverId: string;
  readonly scope: InviteContextScope;
}

/**
 * What every primitive hands back: the row as the caller may show it, and the
 * domain event the caller MUST emit after its transaction commits, through
 * `InviteService.emit(...)`. Emitting inside the transaction would announce a
 * transition a rollback then undoes; the same ride-back `QuotaService.consume`
 * uses for its soft overages.
 */
export interface InviteOutcome<View, Event> {
  readonly invite: View;
  readonly event: Event;
}

/**
 * A create hands back one more thing: the `invite.expired` events for any
 * outstanding invite to the same invitee and context whose window had closed
 * but which nothing had stamped yet. The create stamps those inside the
 * caller's transaction, since the partial unique index would otherwise still
 * count them and refuse the new row. Emit them after commit with `event`.
 */
export interface InviteCreation extends InviteOutcome<InvitePartyView, InviteCreatedEvent> {
  readonly expired: readonly InviteExpiredEvent[];
}

export type InviteAcceptance = InviteOutcome<InvitePartyView, InviteAcceptedEvent>;
export type InviteDeclination = InviteOutcome<InvitePartyView, InviteDeclinedEvent>;
export type InviteWithdrawal = InviteOutcome<InvitePartyView, InviteWithdrawnEvent>;
export type InviteRevocation = InviteOutcome<InviteContextView, InviteRevokedEvent>;
export type InviteApproval = InviteOutcome<InviteContextView, InviteApprovedEvent>;

/** A bulk revoke: how many rows moved, and one domain event per row for the caller to emit after commit. */
export interface OutstandingInviteRevocation {
  readonly count: number;
  readonly events: readonly InviteRevokedEvent[];
}
