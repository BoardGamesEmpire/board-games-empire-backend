import { VoteType } from '@bge/database';
import { INT32_MAX } from '@bge/game-search';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CastVoteDto {
  @ApiProperty({ enum: VoteType })
  @IsEnum(VoteType, { message: i18nValidationMessage('validation.isEnum') })
  voteType!: VoteType;

  @ApiPropertyOptional({
    description: 'Rank preference (1 = highest). Used for ranked-choice tallying.',
    type: 'integer',
    format: 'int32',
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  priority?: number;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  comment?: string;
}
