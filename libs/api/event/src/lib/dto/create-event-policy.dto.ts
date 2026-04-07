import { GameAdditionMode, InterestedWeight, VoteEligibility, VoteQuorumType, VoteThresholdType } from '@bge/database';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min, ValidateIf } from 'class-validator';

export class CreateEventPolicyDto {
  // --- Invite controls ---

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  allowMemberInvites?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  allowGuestInvites?: boolean;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  maxAttendees?: number;

  // --- Participation controls ---

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  requireHostApprovalToJoin?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  allowSpectators?: boolean;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  maxTotalParticipants?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  strictCapacity?: boolean;

  // --- Game controls ---

  @ApiPropertyOptional({ enum: GameAdditionMode, default: GameAdditionMode.Direct })
  @IsEnum(GameAdditionMode)
  @IsOptional()
  gameAdditionMode?: GameAdditionMode;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  restrictToAttendeePool?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  restrictToGameCategories?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ValidateIf((o: CreateEventPolicyDto) => o.restrictToGameCategories === true)
  allowedCategoryIds?: string[];

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  fillerMaxPlayTime?: number;

  // --- Voting controls (only meaningful when gameAdditionMode = RequiresVote) ---

  @ApiPropertyOptional({ enum: VoteThresholdType, default: VoteThresholdType.SimpleMajority })
  @IsEnum(VoteThresholdType)
  @IsOptional()
  voteThresholdType?: VoteThresholdType;

  @ApiPropertyOptional({ description: 'Required for Supermajority (e.g. 66) and FixedCount (e.g. 3)' })
  @IsInt()
  @Min(1)
  @ValidateIf(
    (o: CreateEventPolicyDto) =>
      o.voteThresholdType === VoteThresholdType.Supermajority || o.voteThresholdType === VoteThresholdType.FixedCount,
  )
  voteThresholdValue?: number;

  @ApiPropertyOptional({ enum: VoteQuorumType, default: VoteQuorumType.None })
  @IsEnum(VoteQuorumType)
  @IsOptional()
  voteQuorumType?: VoteQuorumType;

  @ApiPropertyOptional({ description: 'Required for PercentOfAttendees and FixedCount quorum types' })
  @IsInt()
  @Min(1)
  @ValidateIf(
    (o: CreateEventPolicyDto) =>
      o.voteQuorumType === VoteQuorumType.PercentOfAttendees || o.voteQuorumType === VoteQuorumType.FixedCount,
  )
  voteQuorumValue?: number;

  @ApiPropertyOptional({ enum: VoteEligibility, default: VoteEligibility.ConfirmedOnly })
  @IsEnum(VoteEligibility)
  @IsOptional()
  voteEligibility?: VoteEligibility;

  @ApiPropertyOptional({ enum: InterestedWeight, default: InterestedWeight.AsAbstain })
  @IsEnum(InterestedWeight)
  @IsOptional()
  interestedWeight?: InterestedWeight;

  @ApiPropertyOptional({ description: 'Hours a nomination stays open for votes. Null = host closes manually.' })
  @IsInt()
  @Min(1)
  @IsOptional()
  votingWindowHours?: number;
}
