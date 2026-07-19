import { FriendshipStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class ListFriendshipsQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({ enum: FriendshipStatus, description: 'Filter friendships by status' })
  @IsOptional()
  @IsEnum(FriendshipStatus, { message: i18nValidationMessage('validation.isEnum') })
  status?: FriendshipStatus;
}
