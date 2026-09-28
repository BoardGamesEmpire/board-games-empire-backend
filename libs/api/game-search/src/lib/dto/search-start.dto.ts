import { i18nValidationMessage } from '@bge/i18n';
import { CappedOffsetPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class SearchStartDto extends CappedOffsetPaginationQueryDto(100, 20) {
  @IsUUID(undefined, { message: i18nValidationMessage('validation.isUUID') })
  correlationId!: string;

  @IsString({ message: i18nValidationMessage('validation.isString') })
  query!: string;

  /**
   * Gateway IDs to include in the search.
   */
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @IsOptional()
  gatewayIds?: string[];

  /**
   * Whether to include the local DB in the search.
   * Defaults to true — local results are always fast-pathed in parallel.
   */
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  includeLocal?: boolean = true;

  /**
   * Whether to include external sources in the search.
   * Defaults to true — external results are always fast-pathed in parallel.
   */
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  includeExternal?: boolean = true;

  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  locale?: string;

  // `limit` (capped at 100, local page size 20 when absent) and `offset` (bounded
  // by DEFAULT_MAX_OFFSET, default 0) are inherited from
  // CappedOffsetPaginationQueryDto — see #17 and #403. Offset-native for the same
  // reason as SearchQueryDto (#230).
}

export class SearchCancelDto {
  @IsUUID(undefined, { message: i18nValidationMessage('validation.isUUID') })
  correlationId!: string;
}
