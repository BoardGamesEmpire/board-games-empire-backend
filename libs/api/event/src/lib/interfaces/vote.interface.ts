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
  interestedWeight: InterestedWeight;
  voteEligibility: VoteEligibility;
  voteQuorumType: VoteQuorumType;
  voteQuorumValue: number | null;
  voteThresholdType: VoteThresholdType;
  voteThresholdValue: number | null;
}

export interface VoteTally {
  againstCount: number;
  forCount: number;
  interestedCount: number;
  totalVotes: number;
}

/** The statuses a resolve can end a nomination in. */
export type ResolvedStatus =
  typeof NominationStatus.Passed | typeof NominationStatus.Failed | typeof NominationStatus.QuorumNotMet;

export interface ResolutionResult {
  eligibleVoterCount: number;
  quorumMet: boolean;
  status: ResolvedStatus;
  tally: VoteTally;
  thresholdMet: boolean;
}
