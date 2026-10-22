import { Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

/**
 * A century. Each reader turns a day count into a date, `now` minus a
 * retention or `now` plus the reclaim window, and not far past this the date
 * leaves what Postgres stores (4713 BC is its earliest timestamp, about 2.4
 * million days back) and then what JavaScript can represent. So a larger value
 * passes validation and fails in its reader, with a 500 on the reject route
 * and a thrown sweep. A retention longer than a century is unlimited in
 * practice, and the audit retention takes `null` for that.
 *
 * The database holds the three columns to the same range with CHECK
 * constraints (migration 20261005000000_system_setting_day_bounds), so a
 * change here needs a migration too.
 */
const MAX_DAYS = 36_500;

/**
 * Every client shows the name as the server's label, and the anonymous
 * discovery document serves it to anyone who asks, so it is kept to a
 * label's length.
 */
const MAX_NAME_LENGTH = 100;

/**
 * The levels the server's invitee policies take, for households (#278) and
 * events (#546). `FriendsOfFriends` waits on #496, which defines friends of
 * friends, and `Private` would turn every invite of that kind off.
 */
const INVITEE_POLICIES = [Reach.Public, Reach.Friends] as const;

/**
 * Partial update for the `SystemSetting` singleton row. A property the body
 * omits is left unchanged.
 *
 * Each property validates under `@ValidateIf(value !== undefined)` rather than
 * `@IsOptional`, which also skips validation for `null` and lets it reach a
 * column that is not nullable (#571). `auditLogRetentionDays` is the one
 * nullable column, and there `null` means unlimited retention.
 */
export class UpdateSystemSettingsDto {
  @ApiPropertyOptional({
    description:
      'The server display name. Clients read it from /.well-known/bge-identity to label the server when a user is choosing which server to add. Surrounding whitespace is trimmed, and a blank name is rejected.',
    maxLength: MAX_NAME_LENGTH,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(MAX_NAME_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  // Trim before validation, so a whitespace-only name collapses to '' and
  // answers 400 rather than labelling the server with nothing, and the length
  // is measured without the padding.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({
    description: 'Whether to allow users to reset their passwords',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowPasswordResets?: boolean;

  @ApiPropertyOptional({
    description: 'Whether to allow new user registrations',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowUserRegistration?: boolean;

  @ApiPropertyOptional({
    description: 'Whether to allow users to change their usernames',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowUsernameChange?: boolean;

  @ApiPropertyOptional({
    description:
      'How long to keep feedback reports, in days. Feedback reports older than this will be automatically deleted.',
    minimum: 1,
    maximum: MAX_DAYS,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(MAX_DAYS, { message: i18nValidationMessage('validation.max') })
  feedbackReportRetentionDays?: number;

  @ApiPropertyOptional({
    description:
      'Whether the server should apply redaction to feedback reports before storing them. If false, the server will store feedback reports as-is and rely on clients to apply redaction.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  feedbackReportServerRedactionEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Whether a media contribution waits for staff approval before it is published.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  requireContributionApproval?: boolean;

  @ApiPropertyOptional({
    description: 'How long the contributor of a rejected media contribution has to reclaim it, in days.',
    minimum: 1,
    maximum: MAX_DAYS,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(MAX_DAYS, { message: i18nValidationMessage('validation.max') })
  contributionReclaimDays?: number;

  @ApiPropertyOptional({
    description: 'How long to keep audit log entries, in days. Null keeps them indefinitely.',
    minimum: 1,
    maximum: MAX_DAYS,
    nullable: true,
    type: Number,
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(MAX_DAYS, { message: i18nValidationMessage('validation.max') })
  auditLogRetentionDays?: number | null;

  @ApiPropertyOptional({
    description: 'Whether a language a gateway reports waits for admin review instead of being added automatically.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  reviewGatewayLanguages?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether a platform a DataGateway lists that matches no record waits for review instead of being added.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  reviewGatewayPlatforms?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether a category a DataGateway lists that matches no record waits for review instead of being added.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  reviewGatewayCategories?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether a mechanic a DataGateway lists that matches no record waits for review instead of being added.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  reviewGatewayMechanics?: boolean;

  @ApiPropertyOptional({
    description:
      "Who may be invited to a household. Public: anyone. Friends: only the inviter's friends, invited from their account; every invite by email address is refused. A user's own preference can narrow this, never widen it.",
    enum: INVITEE_POLICIES,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(INVITEE_POLICIES, { message: i18nValidationMessage('validation.isIn') })
  householdInviteePolicy?: (typeof INVITEE_POLICIES)[number];

  @ApiPropertyOptional({
    description:
      "Who may be placed on an event by id, at its creation or later. Public: anyone. Friends: only the inviter's friends. A user's own preference can narrow this, never widen it.",
    enum: INVITEE_POLICIES,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(INVITEE_POLICIES, { message: i18nValidationMessage('validation.isIn') })
  eventInviteePolicy?: (typeof INVITEE_POLICIES)[number];
}
