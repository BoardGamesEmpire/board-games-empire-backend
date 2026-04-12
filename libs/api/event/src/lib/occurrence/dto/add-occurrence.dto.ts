import { OccurrenceStatus } from '@bge/database';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class AddOccurrenceDto {
  @ApiPropertyOptional({ description: 'Label e.g. "Day 1", "Saturday Evening"' })
  @IsString()
  @IsOptional()
  label?: string;

  @ApiPropertyOptional()
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  startDate?: Date;

  @ApiPropertyOptional()
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  endDate?: Date;

  @ApiPropertyOptional({ description: 'Overrides event-level location' })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ enum: [OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed] })
  @IsEnum(OccurrenceStatus)
  @IsIn([OccurrenceStatus.Proposed, OccurrenceStatus.Confirmed])
  @IsOptional()
  status?: OccurrenceStatus;

  @ApiPropertyOptional({ default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}
