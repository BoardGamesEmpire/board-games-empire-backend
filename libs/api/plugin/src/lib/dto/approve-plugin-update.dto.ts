import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Shape-only validation: whether the set is the RIGHT set is the service's
 * call — the controller never recomputes the expectation — and a wrong set
 * comes back as the 409 challenge carrying the expected slugs (#321).
 */
export class ApprovePluginUpdateDto {
  @ApiPropertyOptional({
    description:
      'Exact re-entry of every Critical permission slug this approval will grant — the prompt inputs come from ' +
      "the 409 challenge's expectedSlugs; re-submit them verbatim rather than recomputing.",
    type: [String],
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  confirmCriticalSlugs?: string[];
}
