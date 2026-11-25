import type { ContextualInviteType } from '@bge/invites';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { PartyInviteTypeProperty } from './party-invite-type-property';

/**
 * Query contract for `GET /invites` (#230): the page contract plus a filter on
 * the kind of invite (#742).
 */
export class ListReceivedInvitesQueryDto extends DefaultPaginationQueryDto {
  @PartyInviteTypeProperty()
  type?: ContextualInviteType;
}
