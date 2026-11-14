import {
  GameAdditionMode,
  InterestedWeight,
  PlatformType,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
} from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, ValidateIf } from 'class-validator';

const NULL_MEANS_EVENTS = "`null` means the event's.";

/**
 * A patch to a date's own policy (#796): the fields it overrides for that
 * day. Each field is optional, so a patch names only what it changes. A date
 * has no invite controls of its own.
 *
 * Every column takes `null`, which hands the field back to the event's. The
 * three "no restriction" flags can't be null, since `false` already means no
 * flag, so they take `ValidateIf` rather than `IsOptional`, which skips `null`
 * as well as a missing key, and `null` answers 400 naming the field.
 *
 * The allowed lists replace the date's when sent, `[]` hands the list back to
 * the event's, and one left out stays (#1268). They are not columns, so `null`
 * is refused for them too.
 *
 * Like the event's, it is judged with what is stored: the service merges it
 * over the date's policy and folds that over the event's.
 */
export class UpdateOccurrencePolicyDto {
  // --- Game restrictions: categories ---

  @ApiPropertyOptional({
    nullable: true,
    description:
      "`false` lifts the event's category restriction for this date. `None` refuses any value but `null`, " +
      `and \`TightenOnly\` refuses \`false\` while the event restricts categories. ${NULL_MEANS_EVENTS}`,
  })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  restrictToGameCategories?: boolean | null;

  @ApiPropertyOptional({ type: [String], description: "Replaces the date's list. Empty means the event's." })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  allowedCategoryIds?: string[];

  // --- Game restrictions: platforms ---

  @ApiPropertyOptional({
    enum: PlatformType,
    isArray: true,
    description: "Replaces the date's list. Empty means the event's.",
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsEnum(PlatformType, { each: true, message: i18nValidationMessage('validation.each.isEnum') })
  allowedPlatformTypes?: PlatformType[];

  @ApiPropertyOptional({
    type: [String],
    description: "Replaces the date's list. Empty means the event's. When both lists apply, a game must satisfy both.",
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  allowedPlatformIds?: string[];

  @ApiPropertyOptional({
    description:
      "No platform type restriction for this date, whatever the event's. Only under the event's `Any` override " +
      'scope, and not beside `allowedPlatformTypes`.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  platformTypesUnrestricted?: boolean;

  @ApiPropertyOptional({
    description:
      "No platform restriction for this date, whatever the event's. Only under the event's `Any` override scope, " +
      'and not beside `allowedPlatformIds`.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  platformsUnrestricted?: boolean;

  // --- Capacity ---

  @ApiPropertyOptional({ nullable: true, description: NULL_MEANS_EVENTS })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  maxAttendees?: number | null;

  @ApiPropertyOptional({ nullable: true, description: NULL_MEANS_EVENTS })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  maxTotalParticipants?: number | null;

  @ApiPropertyOptional({ nullable: true, description: NULL_MEANS_EVENTS })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  strictCapacity?: boolean | null;

  @ApiPropertyOptional({
    description:
      "No capacity limit for this date, whatever the event's. Only under the event's `Any` override scope, and " +
      'not beside `maxAttendees` or `maxTotalParticipants`.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  capacityUnrestricted?: boolean;

  // --- Participation ---

  @ApiPropertyOptional({ nullable: true, description: NULL_MEANS_EVENTS })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  requireHostApprovalToJoin?: boolean | null;

  @ApiPropertyOptional({ nullable: true, description: NULL_MEANS_EVENTS })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  allowSpectators?: boolean | null;

  // --- Game controls ---

  @ApiPropertyOptional({ enum: GameAdditionMode, nullable: true, description: NULL_MEANS_EVENTS })
  @IsEnum(GameAdditionMode, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  gameAdditionMode?: GameAdditionMode | null;

  @ApiPropertyOptional({ nullable: true, description: NULL_MEANS_EVENTS })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  restrictToAttendeePool?: boolean | null;

  @ApiPropertyOptional({ nullable: true, description: `Minutes. ${NULL_MEANS_EVENTS}` })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  fillerMaxPlayTime?: number | null;

  // --- Voting controls (only meaningful when gameAdditionMode = RequiresVote) ---

  @ApiPropertyOptional({ enum: VoteThresholdType, nullable: true, description: NULL_MEANS_EVENTS })
  @IsEnum(VoteThresholdType, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  voteThresholdType?: VoteThresholdType | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "Supermajority (e.g. 66) and FixedCount (e.g. 3) need a value, the date's or the event's. A Supermajority " +
      `percentage is at most 100. ${NULL_MEANS_EVENTS}`,
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  voteThresholdValue?: number | null;

  @ApiPropertyOptional({ enum: VoteQuorumType, nullable: true, description: NULL_MEANS_EVENTS })
  @IsEnum(VoteQuorumType, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  voteQuorumType?: VoteQuorumType | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "PercentOfAttendees and FixedCount quorum types need a value, the date's or the event's. A " +
      `PercentOfAttendees percentage is at most 100. ${NULL_MEANS_EVENTS}`,
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  voteQuorumValue?: number | null;

  @ApiPropertyOptional({ enum: VoteEligibility, nullable: true, description: NULL_MEANS_EVENTS })
  @IsEnum(VoteEligibility, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  voteEligibility?: VoteEligibility | null;

  @ApiPropertyOptional({ enum: InterestedWeight, nullable: true, description: NULL_MEANS_EVENTS })
  @IsEnum(InterestedWeight, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  interestedWeight?: InterestedWeight | null;

  @ApiPropertyOptional({
    nullable: true,
    description: `Hours a nomination for this date stays open for votes. ${NULL_MEANS_EVENTS}`,
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  votingWindowHours?: number | null;
}
