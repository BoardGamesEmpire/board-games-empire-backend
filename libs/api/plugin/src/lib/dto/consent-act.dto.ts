import { PluginGrantStatus, RiskLevel } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import type { ConsentActAnswer } from '@bge/plugin';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * The most answers one consent act carries (#1150). The plugin manifest
 * schema sets no maximum on `permissions.checks`, so this cap is the edge's
 * own: it bounds the work one request can ask the consent act service to
 * plan and lock, far above any manifest a person could read through.
 */
export const CONSENT_ACT_MAX_ANSWERS = 512;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The longest locale a write that stores a presentation takes (#1301): room
 * for any BCP 47 tag a server could support, with a bound on what the 422
 * echoes back.
 */
export const CONSENT_ACT_LOCALE_MAX_LENGTH = 35;

/** A consent decision answers with one of these; there is no "unset" (#1150). */
const ANSWER_STATUSES = [PluginGrantStatus.Granted, PluginGrantStatus.Denied] as const;

/**
 * One answer to one requested permission, as the consent surface showed it
 * (#1150). Shape-only validation: whether the permission is requested, at
 * this unit's scope, and still at the shown risk is the consent act service's
 * call, and every refusal comes back as its typed error through the filter.
 */
export class ConsentAnswerDto implements ConsentActAnswer {
  @ApiProperty({
    description:
      "Canonical slug of the requested permission: the 'plugin|<slug>|<bare>' form for a permission the plugin " +
      'declares, the core slug otherwise, exactly as the consent surface lists it.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  permissionSlug!: string;

  @ApiProperty({
    enum: ANSWER_STATUSES,
    description: 'Granted, or Denied: a durable refusal that a later consent act can change.',
  })
  @IsIn(ANSWER_STATUSES, { message: i18nValidationMessage('validation.isIn') })
  status!: PluginGrantStatus;

  @ApiProperty({
    enum: RiskLevel,
    description:
      'The risk level the consent surface showed for this permission. If it has changed since, the consent act ' +
      'is refused (409 PLUGIN_CONSENT_ACT_STALE), so nobody consents to a risk they were not shown.',
  })
  @IsEnum(RiskLevel, { message: i18nValidationMessage('validation.isEnum') })
  riskLevel!: RiskLevel;
}

/**
 * What every consent act names: the plugin artifact whose consent surface was
 * answered (#1150), and, optionally, the locale that surface was shown in
 * (#1301). Whether the server supports the locale is the controller's call.
 */
abstract class ConsentActBodyDto {
  @ApiProperty({
    description:
      'manifestSha256 from the consent surface the answers were read from: the active one, or, at household or ' +
      "user scope, the staged update's (manifest=staged). Any other sha answers 409 PLUGIN_CONSENT_ACT_STALE.",
    pattern: SHA256_HEX.source,
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Matches(SHA256_HEX, { message: i18nValidationMessage('validation.isSha256') })
  manifestSha256!: string;

  @ApiPropertyOptional({
    description:
      'The locale the consent surface was shown in, as its reasons reported it. The consent act records its ' +
      'presentation in this locale, so it holds the text that was read. Without it, the request locale is used. ' +
      'A locale this server does not support answers 422 PLUGIN_CONSENT_ACT_LOCALE.',
    maxLength: CONSENT_ACT_LOCALE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(CONSENT_ACT_LOCALE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  locale?: string;
}

/**
 * What every switch-on carries (#1150): the answers grant at least every
 * required permission the unit decides, and may answer optional ones. The
 * list may be empty when the plugin requires nothing of the unit, but the
 * property itself is required, so a client always says what it answered.
 */
abstract class SwitchOnPluginDto extends ConsentActBodyDto {
  @ApiProperty({
    type: [ConsentAnswerDto],
    maxItems: CONSENT_ACT_MAX_ANSWERS,
    description:
      'The answers to the requested permissions this unit decides. Every required one must be Granted ' +
      '(422 PLUGIN_CONSENT_ACT_REQUIRED_SET otherwise). May be empty when nothing is required.',
  })
  // No @IsOptional: an absent list fails isArray, so the property is required.
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayMaxSize(CONSENT_ACT_MAX_ANSWERS, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => ConsentAnswerDto)
  answers!: ConsentAnswerDto[];
}

/** Switching a plugin on for your own unit (#1150): the answers cover the permissions you decide at user scope. */
export class SwitchOnUserPluginDto extends SwitchOnPluginDto {}

/**
 * Switching a plugin on for a household (#1150), with optional inline config.
 * Nested under one declared `config` property for the same reasons as the
 * config PATCH: the global pipe strips undeclared top-level properties, and
 * the plugin's own keys must never collide with this body's.
 */
export class SwitchOnHouseholdPluginDto extends SwitchOnPluginDto {
  @ApiPropertyOptional({
    description:
      "Household configuration written with the switch-on, validated against the manifest's config.schema " +
      '(422 on a violation). Needed when the plugin requires household configuration and no valid one is kept ' +
      '(409 otherwise).',
    type: 'object',
    additionalProperties: true,
  })
  // ValidateIf, not @IsOptional: @IsOptional also lets null through, and the
  // service treats "present" as `!== undefined`, so only absence skips.
  @ValidateIf((dto: SwitchOnHouseholdPluginDto) => dto.config !== undefined)
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  config?: Record<string, unknown>;
}

/**
 * Granting or refusing one optional requested permission (#1150), at
 * household, user or Server scope (#1336). A household or user unit must be
 * switched on; the Server unit's toggle does not read the Server switch.
 */
export class ToggleConsentDto extends ConsentActBodyDto {
  @ApiProperty({
    type: ConsentAnswerDto,
    description:
      'The one answer, to an optional requested permission. A required permission cannot be toggled ' +
      '(422 PLUGIN_CONSENT_ACT_ANSWER). A household or user refuses one by switching the plugin off or in a ' +
      'review; a server admin by switching the plugin off or uninstalling it.',
  })
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  @ValidateNested()
  @Type(() => ConsentAnswerDto)
  answer!: ConsentAnswerDto;
}

/**
 * Answering what the active manifest leaves outstanding (#1150), at
 * household, user or Server scope (#1336), or, at household or user scope
 * only, what a staged update adds.
 */
export class ReviewConsentDto extends ConsentActBodyDto {
  @ApiProperty({
    type: [ConsentAnswerDto],
    minItems: 1,
    maxItems: CONSENT_ACT_MAX_ANSWERS,
    description:
      'At least one answer. In a household or user review, refusing a required permission switches the unit ' +
      'off in the same consent act (switchedOff: true in the response). A server review only grants: an answer ' +
      'that refuses is 422 PLUGIN_CONSENT_ACT_ANSWER (rule server-refusal).',
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(CONSENT_ACT_MAX_ANSWERS, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => ConsentAnswerDto)
  answers!: ConsentAnswerDto[];
}
