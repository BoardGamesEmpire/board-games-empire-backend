import { FeedbackCategory, FeedbackContext, FeedbackSeverity } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
} from 'class-validator';
import {
  FEEDBACK_MAX_APP_VERSION_LENGTH,
  FEEDBACK_MAX_CORRELATION_KEY_LENGTH,
  FEEDBACK_MAX_LOCALE_LENGTH,
  FEEDBACK_MAX_MESSAGE_LENGTH,
  FEEDBACK_MAX_PLATFORM_LENGTH,
  FEEDBACK_MAX_REDACTED_FIELDS,
  FEEDBACK_MAX_TITLE_LENGTH,
} from '../constants/feedback.constants';

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
  @IsEnum(FeedbackCategory)
  category!: FeedbackCategory;

  @ApiProperty({
    description: 'Free-form report body. Length-capped at the field level; transport-capped at 256 KB.',
    maxLength: FEEDBACK_MAX_MESSAGE_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(FEEDBACK_MAX_MESSAGE_LENGTH)
  message!: string;

  @ApiPropertyOptional({ description: 'Short title; surfaced as the GitHub issue title when forwarded.' })
  @IsOptional()
  @IsString()
  @MaxLength(FEEDBACK_MAX_TITLE_LENGTH)
  title?: string;

  @ApiPropertyOptional({
    enum: FeedbackContext,
    default: FeedbackContext.Unknown,
    description: 'Client- vs server-side scope. Drives sink routing once external drivers exist.',
  })
  @IsOptional()
  @IsEnum(FeedbackContext)
  context?: FeedbackContext;

  @ApiPropertyOptional({
    enum: FeedbackSeverity,
    description: 'Severity. Required when category is Crash or Bug.',
  })
  @ValidateIf(
    (dto: CreateFeedbackReportDto) => dto.severity !== undefined || SEVERITY_REQUIRED_CATEGORIES.has(dto.category),
  )
  @IsEnum(FeedbackSeverity)
  severity?: FeedbackSeverity;

  @ApiPropertyOptional({ description: 'Submitting client app version (e.g. "0.4.1").' })
  @IsOptional()
  @IsString()
  @MaxLength(FEEDBACK_MAX_APP_VERSION_LENGTH)
  appVersion?: string;

  @ApiPropertyOptional({ description: 'Submitting platform (e.g. "android", "ios", "web", "desktop").' })
  @IsOptional()
  @IsString()
  @MaxLength(FEEDBACK_MAX_PLATFORM_LENGTH)
  platform?: string;

  @ApiPropertyOptional({ description: 'BCP-47 locale (e.g. "en-US").' })
  @IsOptional()
  @IsString()
  @MaxLength(FEEDBACK_MAX_LOCALE_LENGTH)
  locale?: string;

  @ApiPropertyOptional({
    description: 'Free-form client-supplied device/environment context. Validated as an object only.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  deviceInfo?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Idempotency token. Column persisted; server-side short-circuit deferred (see backlog).',
    maxLength: FEEDBACK_MAX_CORRELATION_KEY_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(FEEDBACK_MAX_CORRELATION_KEY_LENGTH)
  correlationKey?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Field paths the client redacted before submission. Sets redactionApplied=true server-side.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(FEEDBACK_MAX_REDACTED_FIELDS)
  userRedactedFields?: string[];
}
