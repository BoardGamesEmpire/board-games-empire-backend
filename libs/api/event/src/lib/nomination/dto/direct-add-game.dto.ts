import { ScheduledGameRole } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class DirectAddGameDto {
  @ApiProperty({ description: 'The PlatformGame to add to the lineup (specific game + platform combination)' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  platformGameId!: string;

  @ApiProperty({
    description:
      'The EventAttendeeGameList entry that sources this game. ' + 'Identifies who is physically bringing it.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  suppliedById!: string;

  @ApiPropertyOptional({
    description: 'Target a specific occurrence. Null = event-level.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  occurrenceId?: string;

  @ApiPropertyOptional({ enum: ScheduledGameRole, default: ScheduledGameRole.Primary })
  @IsEnum(ScheduledGameRole, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  role?: ScheduledGameRole;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'For Filler role only — max play time in minutes' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  maxPlayTime?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  sortOrder?: number;
}
