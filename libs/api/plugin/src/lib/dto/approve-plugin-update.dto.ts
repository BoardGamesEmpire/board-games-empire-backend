import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Shape-only validation: whether the set is the RIGHT set is the service's
 * call — the controller never recomputes the expectation — and a wrong set
 * comes back as the 409 challenge carrying the expected slugs (#321). The
 * same holds for `stagingId`: whether it names the current staging is the
 * service's call (#357).
 */
export class ApprovePluginUpdateDto {
  @ApiProperty({
    description:
      'The staged update this approval answers: `stagingId` from GET /plugins/:slug/update/pending. If another ' +
      'staging has replaced it since, the approval answers 409 PluginUpdateStagingReplacedError and activates ' +
      'nothing.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  stagingId!: string;

  @ApiPropertyOptional({
    description:
      'Exact re-entry of every Critical permission slug this approval will grant — the prompt inputs come from ' +
      "the 409 challenge's expectedSlugs; re-submit them verbatim rather than recomputing.",
    type: [String],
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @IsOptional()
  confirmCriticalSlugs?: string[];
}
