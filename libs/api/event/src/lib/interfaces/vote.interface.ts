import type {
  InterestedWeight,
  NominationStatus,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
} from '@bge/database';

/**
 * Policy fields needed for resolution. Matches the shape of EventPolicy
 * and EventOccurrencePolicy (via ?? fallback at the call site).
 */
export interface VotingPolicy {
  voteThresholdType: VoteThresholdType;
  voteThresholdValue: number | null;
  voteQuorumType: VoteQuorumType;
  voteQuorumValue: number | null;
  voteEligibility: VoteEligibility;
  interestedWeight: InterestedWeight;
}

export interface VoteTally {
  forCount: number;
  againstCount: number;
  interestedCount: number;
  totalVotes: number;
}

export interface ResolutionResult {
  status: NominationStatus;
  tally: VoteTally;
  quorumMet: boolean;
  thresholdMet: boolean;
  eligibleVoterCount: number;
}
