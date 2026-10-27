import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Query contract for `GET /events`: the #230 page contract plus whether to
 * list archived events (#795). An archived event is left out of the list by
 * default and stays readable by id.
 */
export class ListEventsQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({ default: false, description: 'Include archived events (#795)' })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  includeArchived?: boolean;
}
