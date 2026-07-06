import { FriendshipStatus } from '@bge/database';
import { PaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class ListFriendshipsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: FriendshipStatus, description: 'Filter friendships by status' })
  @IsOptional()
  @IsEnum(FriendshipStatus)
  status?: FriendshipStatus;
}
