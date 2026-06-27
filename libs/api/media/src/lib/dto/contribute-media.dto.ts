import { ResourceType } from '@bge/database';
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
  @IsIn(CONTRIBUTABLE_SUBJECT_TYPES)
  subjectType!: ContributableSubjectType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  subjectId!: string;

  @ApiPropertyOptional({ description: 'e.g. "rulebook", "score_card" — feeds the future subject join row' })
  @IsOptional()
  @IsString()
  category?: string;
}
