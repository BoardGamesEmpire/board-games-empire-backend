import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class NominateGameDto {
  @ApiProperty({ description: 'The game to nominate' })
  @IsString()
  gameId!: string;

  @ApiProperty({
    description:
      'The EventAttendeeGameList entry that sources this game. ' + "Must exist in an attendee's available games list.",
  })
  @IsString()
  suppliedFromId!: string;

  @ApiPropertyOptional({
    description: 'Target a specific occurrence (MultiDay events). ' + 'Null = event-level nomination.',
  })
  @IsString()
  @IsOptional()
  occurrenceId?: string;
}
