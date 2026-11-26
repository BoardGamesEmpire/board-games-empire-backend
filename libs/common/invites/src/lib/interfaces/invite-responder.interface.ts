import type { ContextualInviteType } from '../constants/invite.constants';
import type { InvitePartyView } from '../read-shapes';
import type { InviteTarget } from './invite-service.interfaces';

/**
 * What a party route hands an invite to once it knows the invite's type
 * (#742). The route is the same for every kind of invite (inbox, sent list,
 * accept, decline, withdraw), and the responder is the one place that knows
 * what moving the invite means for its context: a household admits a household member,
 * an event seats an attendee.
 *
 * The route picks a responder by its `type`.
 *
 * `Accepted` is what the accept answers with, which carries the invite and
 * whatever the context added beside it.
 */
export interface InviteResponder<Accepted extends { readonly invite: InvitePartyView }> {
  accept(target: InviteTarget, actingUserId: string): Promise<Accepted>;
  decline(target: InviteTarget, actingUserId: string): Promise<InvitePartyView>;
  readonly type: ContextualInviteType;
  withdraw(inviteId: string, actingUserId: string): Promise<InvitePartyView>;
}
