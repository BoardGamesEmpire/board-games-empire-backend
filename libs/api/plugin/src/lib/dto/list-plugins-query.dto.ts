import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Query contract for the SERVER installed-plugin list (#354): the #230 page
 * contract (`page` 1-based, `limit`) plus the one filter the inventory needs.
 *
 * The two unit lists bind `DefaultPaginationQueryDto` directly instead of
 * this class, so `?includeUninstalled=` there is a 400 under
 * `forbidNonWhitelisted` rather than a parameter that looks accepted and is
 * ignored. They never serve tombstones: a tombstoned plugin can never be
 * participated in again, so admitting one to a unit list would hand a
 * non-admin uninstall history with nothing behind it.
 *
 * `includeUninstalled` also has no counterpart on `GET /plugins/:slug` —
 * that route answers 410 for a tombstone unconditionally, because a flag able
 * to turn a 410 into a 200 would make one route report two statuses for
 * identical state.
 */
export class ListPluginsQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Include uninstalled (tombstoned) plugins, which are excluded by default',
    default: false,
  })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  @IsOptional()
  includeUninstalled?: boolean;
}
