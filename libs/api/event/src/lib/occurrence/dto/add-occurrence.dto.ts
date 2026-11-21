import { OccurrenceStatus } from '@bge/database';
import { INT32_MAX } from '@bge/game-search';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class AddOccurrenceDto {
  @ApiPropertyOptional({ description: 'Label e.g. "Day 1", "Saturday Evening"' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  label?: string;

  @ApiPropertyOptional()
  @IsDate({ message: i18nValidationMessage('validation.isDate') })
  @Type(() => Date)
  @IsOptional()
  startDate?: Date;

  @ApiPropertyOptional()
  @IsDate({ message: i18nValidationMessage('validation.isDate') })
  @Type(() => Date)
  @IsOptional()
  endDate?: Date;

  @ApiPropertyOptional({ description: 'Overrides event-level location' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ enum: [OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed] })
  @IsEnum(OccurrenceStatus, { message: i18nValidationMessage('validation.isEnum') })
  @IsIn([OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed], { message: i18nValidationMessage('validation.isIn') })
  @IsOptional()
  status?: OccurrenceStatus;

  @ApiPropertyOptional({ default: 0, type: 'integer', format: 'int32' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  sortOrder?: number;
}
