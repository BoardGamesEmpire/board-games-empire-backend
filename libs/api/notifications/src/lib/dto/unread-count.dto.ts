import { ApiProperty } from '@nestjs/swagger';

export class UnreadCountDto {
  @ApiProperty({ description: "The caller's unread notifications, uncapped", example: 3 })
  count!: number;
}
