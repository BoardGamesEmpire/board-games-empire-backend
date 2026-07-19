import { MediaContributionStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class ListContributionsQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({ enum: MediaContributionStatus })
  @IsOptional()
  @IsEnum(MediaContributionStatus, { message: i18nValidationMessage('validation.isEnum') })
  status?: MediaContributionStatus;
}
