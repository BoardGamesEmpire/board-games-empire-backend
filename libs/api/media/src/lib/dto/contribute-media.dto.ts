import { ResourceType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Subjects with media join tables today (Game/Event images & documents).
 *  Deny-by-default keeps nonsensical targets (Quota, Notification, …) out.
 */
export const CONTRIBUTABLE_SUBJECT_TYPES = [ResourceType.Game, ResourceType.Event] as const;
export type ContributableSubjectType = (typeof CONTRIBUTABLE_SUBJECT_TYPES)[number];

export class ContributeMediaDto {
  @ApiProperty({ enum: CONTRIBUTABLE_SUBJECT_TYPES })
  @IsIn(CONTRIBUTABLE_SUBJECT_TYPES, { message: i18nValidationMessage('validation.isIn') })
  subjectType!: ContributableSubjectType;

  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  subjectId!: string;

  @ApiPropertyOptional({ description: 'e.g. "rulebook", "score_card" — feeds the future subject join row' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  category?: string;
}
