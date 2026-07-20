import { FeedbackCategory, FeedbackContext, FeedbackSeverity } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  FEEDBACK_BREADCRUMBS_MAX_BYTES,
  FEEDBACK_MAX_APP_VERSION_LENGTH,
  FEEDBACK_MAX_CORRELATION_KEY_LENGTH,
  FEEDBACK_MAX_LOCALE_LENGTH,
  FEEDBACK_MAX_MESSAGE_LENGTH,
  FEEDBACK_MAX_PLATFORM_LENGTH,
  FEEDBACK_MAX_REDACTED_FIELDS,
  FEEDBACK_MAX_STACK_TRACE_LENGTH,
  FEEDBACK_MAX_TITLE_LENGTH,
} from '../constants/feedback.constants';
import { MaxJsonBytes } from '../validators/max-json-bytes.validator';
import { BreadcrumbDto } from './breadcrumb.dto';

/** Categories that require a severity. `FeatureRequest` does not. */
const SEVERITY_REQUIRED_CATEGORIES: ReadonlySet<FeedbackCategory> = new Set([
  FeedbackCategory.Crash,
  FeedbackCategory.Bug,
]);

export class CreateFeedbackReportDto {
  @ApiProperty({
    enum: FeedbackCategory,
    description: 'What kind of report this is.',
  })
  @IsEnum(FeedbackCategory, { message: i18nValidationMessage('validation.isEnum') })
  category!: FeedbackCategory;

  @ApiProperty({
    description: 'Free-form report body. Length-capped at the field level; transport-capped at 256 KB.',
    maxLength: FEEDBACK_MAX_MESSAGE_LENGTH,
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(FEEDBACK_MAX_MESSAGE_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  message!: string;

  @ApiPropertyOptional({
    description:
      'Stack trace for crash-category reports. Client truncates tail-preserving (head clipped) when the trace exceeds the cap; the backend rejects anything past it.',
    maxLength: FEEDBACK_MAX_STACK_TRACE_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(FEEDBACK_MAX_STACK_TRACE_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  stackTrace?: string;

  @ApiPropertyOptional({ description: 'Short title; surfaced as the GitHub issue title when forwarded.' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(FEEDBACK_MAX_TITLE_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  title?: string;

  @ApiPropertyOptional({
    enum: FeedbackContext,
    default: FeedbackContext.Unknown,
    description: 'Client- vs server-side scope. Drives sink routing once external drivers exist.',
  })
  @IsOptional()
  @IsEnum(FeedbackContext, { message: i18nValidationMessage('validation.isEnum') })
  context?: FeedbackContext;

  @ApiPropertyOptional({
    enum: FeedbackSeverity,
    description: 'Severity. Required when category is Crash or Bug.',
  })
  @ValidateIf(
    (dto: CreateFeedbackReportDto) => dto.severity !== undefined || SEVERITY_REQUIRED_CATEGORIES.has(dto.category),
  )
  @IsEnum(FeedbackSeverity, { message: i18nValidationMessage('validation.isEnum') })
  severity?: FeedbackSeverity;

  @ApiPropertyOptional({ description: 'Submitting client app version (e.g. "0.4.1").' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(FEEDBACK_MAX_APP_VERSION_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  appVersion?: string;

  @ApiPropertyOptional({ description: 'Submitting platform (e.g. "android", "ios", "web", "desktop").' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(FEEDBACK_MAX_PLATFORM_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  platform?: string;

  @ApiPropertyOptional({ description: 'BCP-47 locale (e.g. "en-US").' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(FEEDBACK_MAX_LOCALE_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  locale?: string;

  @ApiPropertyOptional({
    description: 'Free-form client-supplied device/environment context. Validated as an object only.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  deviceInfo?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: () => [BreadcrumbDto],
    description:
      'Client-emitted breadcrumb ring (post sanitization; see the Dart `BreadcrumbBuffer`). Aggregate size capped at FEEDBACK_BREADCRUMBS_MAX_BYTES UTF-8 bytes.',
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ValidateNested({ each: true })
  @Type(() => BreadcrumbDto)
  @MaxJsonBytes(FEEDBACK_BREADCRUMBS_MAX_BYTES)
  breadcrumbs?: BreadcrumbDto[];

  @ApiPropertyOptional({
    description: 'Idempotency token. Column persisted; server-side short-circuit deferred (see backlog).',
    maxLength: FEEDBACK_MAX_CORRELATION_KEY_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(FEEDBACK_MAX_CORRELATION_KEY_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  correlationKey?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Field paths the client redacted before submission. Sets redactionApplied=true server-side.',
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.isString') })
  @ArrayMaxSize(FEEDBACK_MAX_REDACTED_FIELDS, { message: i18nValidationMessage('validation.arrayMaxSize') })
  userRedactedFields?: string[];
}
