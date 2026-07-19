import { FriendshipStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

/**
 * The set of statuses a participant may transition a friendship to via PATCH.
 * `Pending` is only ever set on creation, so it is intentionally excluded — the
 * service further restricts which participant may apply which transition.
 */
export const RespondableFriendshipStatus = {
  Accepted: FriendshipStatus.Accepted,
  Declined: FriendshipStatus.Declined,
  Withdrawn: FriendshipStatus.Withdrawn,
  Blocked: FriendshipStatus.Blocked,
} as const;

export type RespondableFriendshipStatus =
  (typeof RespondableFriendshipStatus)[keyof typeof RespondableFriendshipStatus];

export class RespondFriendRequestDto {
  @ApiProperty({
    enum: RespondableFriendshipStatus,
    description: 'Accept/Decline (addressee), Withdraw (requester), or Block (either participant)',
  })
  @IsEnum(RespondableFriendshipStatus, { message: i18nValidationMessage('validation.isEnum') })
  status!: RespondableFriendshipStatus;
}
