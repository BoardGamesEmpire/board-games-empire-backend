import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateFriendRequestDto {
  @ApiProperty({ description: 'The id of the user to send a friend request to' })
  @IsString()
  addresseeId!: string;

  @ApiPropertyOptional({ description: 'An optional message to include with the request' })
  @IsOptional()
  @IsString()
  message?: string;
}
