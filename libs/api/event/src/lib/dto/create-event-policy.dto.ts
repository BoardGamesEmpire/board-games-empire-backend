import {
  GameAdditionMode,
  InterestedWeight,
  OccurrenceOverrideScope,
  PlatformType,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
} from '@bge/database';
import { INT32_MAX } from '@bge/game-search';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { MAX_PERCENT, MIN_SUPERMAJORITY_PERCENT } from '../policy/effective-policy';

/**
 * An event's policy, set when the event is created. Each field is optional: one
 * left out takes its column's default.
 *
 * A column that can't be null takes `ValidateIf` rather than `IsOptional`,
 * which skips `null` as well as a missing key and so let `null` through to the
 * write as a 500 (#1275). A nullable column keeps `IsOptional`, and `null`
 * leaves it empty.
 */
export class CreateEventPolicyDto {
  // --- Invite controls ---

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowMemberInvites?: boolean;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowGuestInvites?: boolean;

  @ApiPropertyOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  maxAttendees?: number;

  // --- Participation controls ---

  @ApiPropertyOptional({ default: false })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  requireHostApprovalToJoin?: boolean;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowSpectators?: boolean;

  @ApiPropertyOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  maxTotalParticipants?: number;

  @ApiPropertyOptional({ default: false })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  strictCapacity?: boolean;

  // --- Game controls ---

  @ApiPropertyOptional({ enum: GameAdditionMode, default: GameAdditionMode.Direct })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(GameAdditionMode, { message: i18nValidationMessage('validation.isEnum') })
  gameAdditionMode?: GameAdditionMode;

  @ApiPropertyOptional({ default: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  restrictToAttendeePool?: boolean;

  @ApiPropertyOptional({ default: false })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  restrictToGameCategories?: boolean;

  // Checked whenever sent, since the ids reach the existence check whatever
  // restrictToGameCategories says, and required when it is true (#1268).
  @ApiPropertyOptional({ type: [String], description: 'Required when restrictToGameCategories is true.' })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @ValidateIf((o: CreateEventPolicyDto, value) => value !== undefined || o.restrictToGameCategories === true)
  allowedCategoryIds?: string[];

  @ApiPropertyOptional({ enum: PlatformType, isArray: true, description: 'Empty means no platform type restriction.' })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsEnum(PlatformType, { each: true, message: i18nValidationMessage('validation.each.isEnum') })
  allowedPlatformTypes?: PlatformType[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Empty means no platform restriction. When both lists are set, a game must satisfy both.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  allowedPlatformIds?: string[];

  @ApiPropertyOptional({
    enum: OccurrenceOverrideScope,
    default: OccurrenceOverrideScope.Any,
    description:
      "How far a date's own policy may override this policy's allowed platform types, platforms and categories, " +
      'and its capacity: None, TightenOnly (only narrower) or Any (replace them, or remove them for that date). ' +
      "Every other field a date sets overrides the event's freely.",
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(OccurrenceOverrideScope, { message: i18nValidationMessage('validation.isEnum') })
  occurrenceOverrideScope?: OccurrenceOverrideScope;

  @ApiPropertyOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  fillerMaxPlayTime?: number;

  // --- Voting controls (only meaningful when gameAdditionMode = RequiresVote) ---

  @ApiPropertyOptional({ enum: VoteThresholdType, default: VoteThresholdType.SimpleMajority })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(VoteThresholdType, { message: i18nValidationMessage('validation.isEnum') })
  voteThresholdType?: VoteThresholdType;

  // Checked whenever sent, as the policy edit checks it. A missing number is
  // the service's to refuse, with the edit's code (#1274).
  @ApiPropertyOptional({
    nullable: true,
    description: `Required for Supermajority (${MIN_SUPERMAJORITY_PERCENT} to ${MAX_PERCENT}) and FixedCount (e.g. 3).`,
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  voteThresholdValue?: number | null;

  @ApiPropertyOptional({ enum: VoteQuorumType, default: VoteQuorumType.None })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(VoteQuorumType, { message: i18nValidationMessage('validation.isEnum') })
  voteQuorumType?: VoteQuorumType;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Required for PercentOfAttendees (1 to 100) and FixedCount quorum types.',
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  voteQuorumValue?: number | null;

  @ApiPropertyOptional({ enum: VoteEligibility, default: VoteEligibility.ConfirmedOnly })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(VoteEligibility, { message: i18nValidationMessage('validation.isEnum') })
  voteEligibility?: VoteEligibility;

  @ApiPropertyOptional({ enum: InterestedWeight, default: InterestedWeight.AsAbstain })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(InterestedWeight, { message: i18nValidationMessage('validation.isEnum') })
  interestedWeight?: InterestedWeight;

  @ApiPropertyOptional({ description: 'Hours a nomination stays open for votes. Null = host closes manually.' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  votingWindowHours?: number;
}
