import { ApiProperty } from '@nestjs/swagger';

export class UnreadCountDto {
  @ApiProperty({ description: 'How many unread notifications the acting user has, uncapped', example: 3 })
  count!: number;
}
