import { VoteType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CastVoteDto {
  @ApiProperty({ enum: VoteType })
  @IsEnum(VoteType, { message: i18nValidationMessage('validation.isEnum') })
  voteType!: VoteType;

  @ApiPropertyOptional({ description: 'Rank preference (1 = highest). Used for ranked-choice tallying.' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  priority?: number;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  comment?: string;
}
