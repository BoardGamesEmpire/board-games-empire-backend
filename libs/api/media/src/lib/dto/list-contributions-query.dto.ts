import { MediaContributionStatus } from '@bge/database';
import { PaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class ListContributionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MediaContributionStatus })
  @IsOptional()
  @IsEnum(MediaContributionStatus)
  status?: MediaContributionStatus;
}
