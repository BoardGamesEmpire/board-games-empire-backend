import { VoteType } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CastVoteDto {
  @ApiProperty({ enum: VoteType })
  @IsEnum(VoteType)
  voteType!: VoteType;

  @ApiPropertyOptional({ description: 'Rank preference (1 = highest). Used for ranked-choice tallying.' })
  @IsInt()
  @Min(1)
  @IsOptional()
  priority?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  comment?: string;
}
