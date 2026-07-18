import { GameAdditionMode, InterestedWeight, VoteEligibility, VoteQuorumType, VoteThresholdType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, ValidateIf } from 'class-validator';

export class CreateEventPolicyDto {
  // --- Invite controls ---

  @ApiPropertyOptional({ default: true })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  allowMemberInvites?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  allowGuestInvites?: boolean;

  @ApiPropertyOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  maxAttendees?: number;

  // --- Participation controls ---

  @ApiPropertyOptional({ default: false })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  requireHostApprovalToJoin?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  allowSpectators?: boolean;

  @ApiPropertyOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  maxTotalParticipants?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  strictCapacity?: boolean;

  // --- Game controls ---

  @ApiPropertyOptional({ enum: GameAdditionMode, default: GameAdditionMode.Direct })
  @IsEnum(GameAdditionMode, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  gameAdditionMode?: GameAdditionMode;

  @ApiPropertyOptional({ default: true })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  restrictToAttendeePool?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  restrictToGameCategories?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.isString') })
  @ValidateIf((o: CreateEventPolicyDto) => o.restrictToGameCategories === true)
  allowedCategoryIds?: string[];

  @ApiPropertyOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  fillerMaxPlayTime?: number;

  // --- Voting controls (only meaningful when gameAdditionMode = RequiresVote) ---

  @ApiPropertyOptional({ enum: VoteThresholdType, default: VoteThresholdType.SimpleMajority })
  @IsEnum(VoteThresholdType, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  voteThresholdType?: VoteThresholdType;

  @ApiPropertyOptional({ description: 'Required for Supermajority (e.g. 66) and FixedCount (e.g. 3)' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @ValidateIf(
    (o: CreateEventPolicyDto) =>
      o.voteThresholdType === VoteThresholdType.Supermajority || o.voteThresholdType === VoteThresholdType.FixedCount,
  )
  voteThresholdValue?: number;

  @ApiPropertyOptional({ enum: VoteQuorumType, default: VoteQuorumType.None })
  @IsEnum(VoteQuorumType, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  voteQuorumType?: VoteQuorumType;

  @ApiPropertyOptional({ description: 'Required for PercentOfAttendees and FixedCount quorum types' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @ValidateIf(
    (o: CreateEventPolicyDto) =>
      o.voteQuorumType === VoteQuorumType.PercentOfAttendees || o.voteQuorumType === VoteQuorumType.FixedCount,
  )
  voteQuorumValue?: number;

  @ApiPropertyOptional({ enum: VoteEligibility, default: VoteEligibility.ConfirmedOnly })
  @IsEnum(VoteEligibility, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  voteEligibility?: VoteEligibility;

  @ApiPropertyOptional({ enum: InterestedWeight, default: InterestedWeight.AsAbstain })
  @IsEnum(InterestedWeight, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  interestedWeight?: InterestedWeight;

  @ApiPropertyOptional({ description: 'Hours a nomination stays open for votes. Null = host closes manually.' })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @IsOptional()
  votingWindowHours?: number;
}
