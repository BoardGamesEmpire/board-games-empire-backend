import { MediaContributionStatus } from '@bge/database';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class ListContributionsQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({ enum: MediaContributionStatus })
  @IsOptional()
  @IsEnum(MediaContributionStatus)
  status?: MediaContributionStatus;
}
