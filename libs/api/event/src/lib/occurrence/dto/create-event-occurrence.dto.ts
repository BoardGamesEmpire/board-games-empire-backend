import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateEventOccurrenceDto {
  @ApiPropertyOptional({ description: 'Label for this occurrence, e.g. "Day 1" or "Saturday Evening"' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  label?: string;

  @ApiPropertyOptional({ description: 'Null for Poll mode proposed occurrences' })
  @IsDate({ message: i18nValidationMessage('validation.isDate') })
  @Type(() => Date)
  @IsOptional()
  startDate?: Date;

  @ApiPropertyOptional()
  @IsDate({ message: i18nValidationMessage('validation.isDate') })
  @Type(() => Date)
  @IsOptional()
  endDate?: Date;

  @ApiPropertyOptional({ description: 'Overrides the event-level location for this occurrence only' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  sortOrder?: number;
}
