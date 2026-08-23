import { i18nValidationMessage } from '@bge/i18n';
import { CappedPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

// Exemplar of the #142 validation convention: point each class-validator
// decorator at a `validation.*` catalog key via the `@bge/i18n` facade. The
// inherited pagination decorators (from CappedPaginationQueryDto) stay unannotated
// and keep emitting English defaults — the full DTO sweep is Phase 3 (#144).
// The 50-row ceiling and 20-row default used to live in LanguageService, where
// the ceiling silently clamped an over-large `limit`. They belong on the DTO now
// that `skip` is derived from the resolved page size: a service-side clamp would
// make page 2 skip a different number of rows than it takes. An over-large
// `limit` is now a 400 like every other capped endpoint (#230).
export class LanguageQueryDto extends CappedPaginationQueryDto(50, 20) {
  @ApiPropertyOptional({ description: 'Filter languages by name (case-insensitive, partial match)' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Filter languages by whether they are supported by the system' })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  @IsOptional()
  systemSupported?: boolean;
}
