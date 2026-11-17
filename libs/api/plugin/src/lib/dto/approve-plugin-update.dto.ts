import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { CONSENT_ACT_LOCALE_MAX_LENGTH } from './consent-act.dto';
import { StagedUpdateAnswerDto } from './staged-update-answer.dto';

/**
 * Shape-only validation: whether the set is the RIGHT set is the service's
 * call — the controller never recomputes the expectation — and a wrong set
 * comes back as the 409 challenge carrying the expected slugs (#321). The
 * same holds for `stagingId`, declared on the shared base (#357, #1118).
 */
export class ApprovePluginUpdateDto extends StagedUpdateAnswerDto {
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

  @ApiPropertyOptional({
    description:
      "The locale the staged-update read presented its requested permissions in. The approval's consent act " +
      'records its presentation in this locale, so it holds the text that was read. Without it, the request ' +
      'locale is used. A locale this server does not support answers 422 PLUGIN_CONSENT_ACT_LOCALE (#1301).',
    maxLength: CONSENT_ACT_LOCALE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(CONSENT_ACT_LOCALE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  locale?: string;
}
