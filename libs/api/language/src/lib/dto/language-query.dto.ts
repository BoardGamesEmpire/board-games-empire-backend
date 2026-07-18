import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

// Exemplar of the #142 validation convention: point each class-validator
// decorator at a `validation.*` catalog key via the `@bge/i18n` facade. The
// inherited pagination decorators (DefaultPaginationQueryDto) stay unannotated
// and keep emitting English defaults — the full DTO sweep is Phase 3 (#144).
export class LanguageQueryDto extends DefaultPaginationQueryDto {
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
