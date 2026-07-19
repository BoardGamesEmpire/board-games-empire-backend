import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { LINKABLE_SUBJECT_TYPES, type LinkableSubjectType } from '../constants/media-link.constants';

export class AttachMediaDto {
  @ApiProperty({ enum: LINKABLE_SUBJECT_TYPES })
  @IsIn(LINKABLE_SUBJECT_TYPES, { message: i18nValidationMessage('validation.isIn') })
  subjectType!: LinkableSubjectType;

  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  subjectId!: string;

  // presentation (applied on first attach)
  @ApiPropertyOptional() @IsOptional() @IsString({ message: i18nValidationMessage('validation.isString') }) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString({ message: i18nValidationMessage('validation.isString') }) caption?: string;
  @ApiPropertyOptional() @IsOptional() @IsString({ message: i18nValidationMessage('validation.isString') }) altText?: string;
  @ApiPropertyOptional() @IsOptional() @IsString({ message: i18nValidationMessage('validation.isString') }) thumbnailUrl?: string;

  // per-attachment context (each subject reads the subset it supports)
  @ApiPropertyOptional() @IsOptional() @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') }) isCover?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') }) isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') }) isFeatured?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt({ message: i18nValidationMessage('validation.isInt') }) @Min(0, { message: i18nValidationMessage('validation.min') }) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsDate({ message: i18nValidationMessage('validation.isDate') }) @Type(() => Date) takenAt?: Date;
  @ApiPropertyOptional() @IsOptional() @IsString({ message: i18nValidationMessage('validation.isString') }) category?: string;
}
