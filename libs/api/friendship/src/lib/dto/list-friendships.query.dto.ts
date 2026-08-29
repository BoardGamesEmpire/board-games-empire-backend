import { FriendshipStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

/**
 * Query contract for `GET /friendships`: the #230 page contract plus the one
 * filter that list needs.
 *
 * `GET /friendships/requests` binds `DefaultPaginationQueryDto` directly rather
 * than this class, so `?status=` there is a 400 under the global pipe's
 * `forbidNonWhitelisted` instead of a parameter that looks accepted and is
 * ignored — that set is Pending by definition. Same reasoning as the plugin
 * unit lists under #354; see `ListPluginsQueryDto`.
 */
export class ListFriendshipsQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({ enum: FriendshipStatus, description: 'Filter friendships by status' })
  @IsOptional()
  @IsEnum(FriendshipStatus, { message: i18nValidationMessage('validation.isEnum') })
  status?: FriendshipStatus;
}
