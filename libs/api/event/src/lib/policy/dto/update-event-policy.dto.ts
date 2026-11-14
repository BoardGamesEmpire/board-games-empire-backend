import {
  GameAdditionMode,
  InterestedWeight,
  OccurrenceOverrideScope,
  PlatformType,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
} from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, ValidateIf } from 'class-validator';

/**
 * A patch to an event's policy (#796). Each field is optional, so a patch
 * names only what it changes.
 *
 * A column that can't be null takes `ValidateIf` rather than `IsOptional`,
 * which skips `null` as well as a missing key, so `null` answers 400 naming
 * the field instead of reaching the write as a 500. A nullable column keeps
 * `IsOptional`, and `null` clears it.
 *
 * It doesn't extend `CreateEventPolicyDto`: the create's `ValidateIf`s require
 * a threshold or quorum value from the type sent beside it, and a patch has to
 * be judged with the stored policy, which the service merges it over.
 *
 * The allowed lists replace the stored one when sent, `[]` clears it, and one
 * left out stays (#1268). They are not columns, so `null` is refused for them
 * as for a column that can't be null.
 */
export class UpdateEventPolicyDto {
  // --- Invite controls ---

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowMemberInvites?: boolean;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowGuestInvites?: boolean;

  @ApiPropertyOptional({ nullable: true, description: '`null` removes the limit.' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  maxAttendees?: number | null;

  // --- Participation controls ---

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  requireHostApprovalToJoin?: boolean;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  allowSpectators?: boolean;

  @ApiPropertyOptional({ nullable: true, description: '`null` removes the limit.' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  maxTotalParticipants?: number | null;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  strictCapacity?: boolean;

  // --- Game controls ---

  @ApiPropertyOptional({ enum: GameAdditionMode })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(GameAdditionMode, { message: i18nValidationMessage('validation.isEnum') })
  gameAdditionMode?: GameAdditionMode;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  restrictToAttendeePool?: boolean;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  restrictToGameCategories?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Replaces the stored list. Empty means no restriction.' })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  allowedCategoryIds?: string[];

  @ApiPropertyOptional({
    enum: PlatformType,
    isArray: true,
    description: 'Replaces the stored list. Empty means no platform type restriction.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsEnum(PlatformType, { each: true, message: i18nValidationMessage('validation.each.isEnum') })
  allowedPlatformTypes?: PlatformType[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Replaces the stored list. Empty means no platform restriction. When both lists are set, a game must satisfy both.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  allowedPlatformIds?: string[];

  @ApiPropertyOptional({
    enum: OccurrenceOverrideScope,
    description:
      "How far a date's own policy may override this policy's allowed platform types, platforms and categories, " +
      'and its capacity: None, TightenOnly (only narrower) or Any (replace them, or remove them for that date). ' +
      'A change to it, or to one of those restrictions, that would leave a date past it answers 400 ' +
      '`EVENT_POLICY_OCCURRENCES_EXCEED_SCOPE`.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(OccurrenceOverrideScope, { message: i18nValidationMessage('validation.isEnum') })
  occurrenceOverrideScope?: OccurrenceOverrideScope;

  @ApiPropertyOptional({ nullable: true, description: 'Minutes. `null` permits no fillers.' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  fillerMaxPlayTime?: number | null;

  // --- Voting controls (only meaningful when gameAdditionMode = RequiresVote) ---

  @ApiPropertyOptional({ enum: VoteThresholdType })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(VoteThresholdType, { message: i18nValidationMessage('validation.isEnum') })
  voteThresholdType?: VoteThresholdType;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Required for Supermajority (e.g. 66) and FixedCount (e.g. 3), sent or already stored, by the event and by ' +
      'every date whose own threshold type relies on it. A Supermajority percentage is at most 100.',
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  voteThresholdValue?: number | null;

  @ApiPropertyOptional({ enum: VoteQuorumType })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(VoteQuorumType, { message: i18nValidationMessage('validation.isEnum') })
  voteQuorumType?: VoteQuorumType;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Required for PercentOfAttendees and FixedCount quorum types, sent or already stored, by the event and by ' +
      'every date whose own quorum type relies on it. A PercentOfAttendees percentage is at most 100.',
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  voteQuorumValue?: number | null;

  @ApiPropertyOptional({ enum: VoteEligibility })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(VoteEligibility, { message: i18nValidationMessage('validation.isEnum') })
  voteEligibility?: VoteEligibility;

  @ApiPropertyOptional({ enum: InterestedWeight })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(InterestedWeight, { message: i18nValidationMessage('validation.isEnum') })
  interestedWeight?: InterestedWeight;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Hours a nomination stays open for votes. `null` means the host closes it.',
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  votingWindowHours?: number | null;
}
