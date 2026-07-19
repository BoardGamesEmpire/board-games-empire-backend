import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { LINKABLE_SUBJECT_TYPES, type LinkableSubjectType } from '../constants/media-link.constants';

export class DetachMediaDto {
  @ApiProperty({ enum: LINKABLE_SUBJECT_TYPES })
  @IsIn(LINKABLE_SUBJECT_TYPES, { message: i18nValidationMessage('validation.isIn') })
  subjectType!: LinkableSubjectType;

  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  subjectId!: string;
}
