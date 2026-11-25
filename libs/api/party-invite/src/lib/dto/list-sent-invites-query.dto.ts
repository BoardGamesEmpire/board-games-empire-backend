import { InviteStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import type { ContextualInviteType } from '@bge/invites';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PartyInviteTypeProperty } from './party-invite-type-property';

/**
 * Query contract for `GET /invites/sent` (#751): the #230 page contract plus a
 * filter on the status an invite has now, and one on the kind of invite
 * (#742).
 */
export class ListSentInvitesQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({
    enum: InviteStatus,
    description:
      'Only invites with this status as it stands now. An outstanding invite past its expiry counts as ' +
      '`Expired` whether or not it has been marked so. Without it, the list is the invites still open, ' +
      '`Pending` or `AwaitingApproval`, and those that expired.',
  })
  @IsOptional()
  @IsEnum(InviteStatus, { message: i18nValidationMessage('validation.isEnum') })
  status?: InviteStatus;

  @PartyInviteTypeProperty()
  type?: ContextualInviteType;
}
