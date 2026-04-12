import {
  EventParticipationStatus,
  InterestedWeight,
  NominationStatus,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
  VoteType,
} from '@bge/database';
import type { ResolutionResult, VoteTally, VotingPolicy } from '../interfaces/vote.interface';

export class VoteResolver {
  /**
   * Resolve a nomination based on cast votes, policy rules, and attendee pool.
   */
  static resolve(votes: VoteStub[], policy: VotingPolicy, attendees: AttendeeStub[]): ResolutionResult {
    const eligibleCount = this.countEligibleVoters(attendees, policy.voteEligibility);
    const tally = this.tally(votes, policy.interestedWeight);
    const quorumMet = this.checkQuorum(tally.totalVotes, eligibleCount, policy);
    const thresholdMet = this.checkThreshold(tally, eligibleCount, policy);

    let status: NominationStatus;
    if (!quorumMet) {
      status = NominationStatus.QuorumNotMet;
    } else if (thresholdMet) {
      status = NominationStatus.Passed;
    } else {
      status = NominationStatus.Failed;
    }

    return {
      status,
      tally,
      quorumMet,
      thresholdMet,
      eligibleVoterCount: eligibleCount,
    } satisfies ResolutionResult;
  }

  /**
   * Count votes, applying InterestedWeight to reclassify Interested votes.
   */
  static tally(votes: VoteStub[], interestedWeight: InterestedWeight): VoteTally {
    let forCount = 0;
    let againstCount = 0;
    let interestedCount = 0;

    for (const vote of votes) {
      switch (vote.voteType) {
        case VoteType.For:
          forCount++;
          break;
        case VoteType.Against:
          againstCount++;
          break;
        case VoteType.Interested:
          interestedCount++;
          break;
      }
    }

    // Apply InterestedWeight reclassification
    let effectiveFor = forCount;
    let effectiveAgainst = againstCount;
    let totalVotes: number;

    switch (interestedWeight) {
      case InterestedWeight.AsFor:
        effectiveFor += interestedCount;
        totalVotes = effectiveFor + effectiveAgainst;
        break;
      case InterestedWeight.AsAgainst:
        effectiveAgainst += interestedCount;
        totalVotes = effectiveFor + effectiveAgainst;
        break;
      case InterestedWeight.AsAbstain:
        // Interested votes excluded from the denominator entirely
        totalVotes = effectiveFor + effectiveAgainst;
        break;
    }

    return {
      forCount: effectiveFor,
      againstCount: effectiveAgainst,
      interestedCount,
      totalVotes,
    } satisfies VoteTally;
  }

  /**
   * Determine how many attendees are eligible to vote based on the policy.
   */
  static countEligibleVoters(attendees: AttendeeStub[], eligibility: VoteEligibility): number {
    switch (eligibility) {
      case VoteEligibility.AllAttendees:
        return attendees.length;
      case VoteEligibility.ConfirmedOnly:
        return attendees.filter((a) => a.status === EventParticipationStatus.Attending).length;
      case VoteEligibility.PoolParticipants:
        return attendees.filter((a) => a.availableGames.length > 0).length;
    }
  }

  /**
   * Check whether enough voters participated to make the result binding.
   */
  static checkQuorum(
    totalVotes: number,
    eligibleCount: number,
    policy: Pick<VotingPolicy, 'voteQuorumType' | 'voteQuorumValue'>,
  ): boolean {
    switch (policy.voteQuorumType) {
      case VoteQuorumType.None:
        return true;
      case VoteQuorumType.FixedCount:
        return totalVotes >= (policy.voteQuorumValue ?? 1);
      case VoteQuorumType.PercentOfAttendees: {
        if (eligibleCount === 0) return false;
        const requiredPercent = (policy.voteQuorumValue ?? 50) / 100;
        return totalVotes >= Math.ceil(eligibleCount * requiredPercent);
      }
    }
  }

  /**
   * Check whether the vote passed the configured threshold.
   */
  static checkThreshold(
    tally: VoteTally,
    eligibleCount: number,
    policy: Pick<VotingPolicy, 'voteThresholdType' | 'voteThresholdValue'>,
  ): boolean {
    switch (policy.voteThresholdType) {
      case VoteThresholdType.SimpleMajority: {
        // >50% of votes cast are For
        return tally.totalVotes > 0 && tally.forCount > tally.totalVotes / 2;
      }

      case VoteThresholdType.Supermajority: {
        const requiredPercent = (policy.voteThresholdValue ?? 66) / 100;
        return tally.totalVotes > 0 && tally.forCount >= Math.ceil(tally.totalVotes * requiredPercent);
      }

      case VoteThresholdType.Unanimous: {
        // All eligible voters must vote For (against = 0, every eligible voter participated as For)
        return tally.againstCount === 0 && tally.forCount === eligibleCount;
      }

      case VoteThresholdType.FixedCount: {
        return tally.forCount >= (policy.voteThresholdValue ?? 1);
      }
    }
  }
}

interface AttendeeStub {
  status: EventParticipationStatus;
  availableGames: { id: string }[];
}

interface VoteStub {
  voteType: VoteType;
}
