import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { LINKABLE_SUBJECT_TYPES, type LinkableSubjectType } from '../constants/media-link.constants';

export class AttachMediaDto {
  @ApiProperty({ enum: LINKABLE_SUBJECT_TYPES })
  @IsIn(LINKABLE_SUBJECT_TYPES)
  subjectType!: LinkableSubjectType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  subjectId!: string;

  // presentation (applied on first attach)
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() caption?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() altText?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() thumbnailUrl?: string;

  // per-attachment context (each subject reads the subset it supports)
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isCover?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsDate() @Type(() => Date) takenAt?: Date;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
}
