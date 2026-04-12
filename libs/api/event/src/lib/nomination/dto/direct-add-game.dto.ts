import { ScheduledGameRole } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class DirectAddGameDto {
  @ApiProperty({ description: 'The game to add to the lineup' })
  @IsString()
  gameId!: string;

  @ApiProperty({
    description:
      'The EventAttendeeGameList entry that sources this game. ' + 'Identifies who is physically bringing it.',
  })
  @IsString()
  suppliedById!: string;

  @ApiPropertyOptional({
    description: 'Target a specific occurrence. Null = event-level.',
  })
  @IsString()
  @IsOptional()
  occurrenceId?: string;

  @ApiPropertyOptional({ enum: ScheduledGameRole, default: ScheduledGameRole.Primary })
  @IsEnum(ScheduledGameRole)
  @IsOptional()
  role?: ScheduledGameRole;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'For Filler role only — max play time in minutes' })
  @IsInt()
  @Min(1)
  @IsOptional()
  maxPlayTime?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}
