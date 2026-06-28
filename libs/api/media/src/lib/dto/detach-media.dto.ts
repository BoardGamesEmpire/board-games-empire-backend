import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { LINKABLE_SUBJECT_TYPES, type LinkableSubjectType } from '../constants/media-link.constants';

export class DetachMediaDto {
  @ApiProperty({ enum: LINKABLE_SUBJECT_TYPES })
  @IsIn(LINKABLE_SUBJECT_TYPES)
  subjectType!: LinkableSubjectType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  subjectId!: string;
}
