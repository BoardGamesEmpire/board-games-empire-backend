import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { CONSENT_ACT_LOCALE_MAX_LENGTH, CONSENT_ACT_MAX_ANSWERS } from './consent-act.dto';
import { ShownRiskDto } from './shown-risk.dto';
import { StagedUpdateAnswerDto } from './staged-update-answer.dto';

/**
 * Shape-only validation: whether the set is the RIGHT set is the service's
 * call — the controller never recomputes the expectation — and a wrong set
 * comes back as the 409 challenge carrying the expected slugs (#321). The
 * same holds for `stagingId`, declared on the shared base (#357, #1118).
 */
export class ApprovePluginUpdateDto extends StagedUpdateAnswerDto {
  @ApiProperty({
    type: [ShownRiskDto],
    description:
      'The risk level the staged-update read showed for every server-scope permission in its ' +
      "`presentation.checks`, one entry each. Approving grants at today's risk, so if one is missing or has " +
      'changed since, the approval is refused (409 PLUGIN_CONSENT_ACT_STALE, kind risk, with staleRisks) and ' +
      'nothing is activated: read the staged update again.',
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayMaxSize(CONSENT_ACT_MAX_ANSWERS, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @ArrayUnique((risk: ShownRiskDto) => risk.permissionSlug, {
    message: i18nValidationMessage('validation.arrayUnique'),
  })
  @ValidateNested({ each: true })
  @Type(() => ShownRiskDto)
  shownRisks!: ShownRiskDto[];

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
      "The staged-update read's `presentation.locale`: the locale it was rendered in, one this server supports. Not the " +
      "locale a reason reports, which names the plugin's own text the reason came from. The approval's consent " +
      'act records its presentation in this locale, so it holds the text that was read. Without it, the request ' +
      "locale is used. The match is exact, since the supported tags are the server's own spelling; a locale this " +
      'server does not support answers 422 PLUGIN_CONSENT_ACT_LOCALE (#1301).',
    maxLength: CONSENT_ACT_LOCALE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(CONSENT_ACT_LOCALE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  locale?: string;
}
