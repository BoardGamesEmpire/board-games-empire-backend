import {
  EventParticipationStatus,
  InterestedWeight,
  NominationStatus,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
  VoteType,
} from '@bge/database';
import type { VotingPolicy } from '../interfaces/vote.interface';
import { VoteResolver } from './vote-resolver';

describe('VoteResolver', () => {
  describe('tally', () => {
    it('counts For, Against, and Interested separately', () => {
      const result = VoteResolver.tally(
        votes(VoteType.For, VoteType.For, VoteType.Against, VoteType.Interested),
        InterestedWeight.AsAbstain,
      );

      expect(result.forCount).toBe(2);
      expect(result.againstCount).toBe(1);
      expect(result.interestedCount).toBe(1);
      expect(result.totalVotes).toBe(3); // Interested excluded
    });

    it('reclassifies Interested as For when AsFor', () => {
      const result = VoteResolver.tally(
        votes(VoteType.For, VoteType.Interested, VoteType.Against),
        InterestedWeight.AsFor,
      );

      expect(result.forCount).toBe(2);
      expect(result.againstCount).toBe(1);
      expect(result.totalVotes).toBe(3);
    });

    it('reclassifies Interested as Against when AsAgainst', () => {
      const result = VoteResolver.tally(
        votes(VoteType.For, VoteType.Interested, VoteType.Interested),
        InterestedWeight.AsAgainst,
      );

      expect(result.forCount).toBe(1);
      expect(result.againstCount).toBe(2);
      expect(result.totalVotes).toBe(3);
    });

    it('handles empty votes array', () => {
      const result = VoteResolver.tally([], InterestedWeight.AsAbstain);

      expect(result.forCount).toBe(0);
      expect(result.totalVotes).toBe(0);
    });
  });

  describe('countEligibleVoters', () => {
    const attendees = [
      makeAttendee(EventParticipationStatus.Attending, 2),
      makeAttendee(EventParticipationStatus.Attending, 0),
      makeAttendee(EventParticipationStatus.Invited, 1),
      makeAttendee(EventParticipationStatus.Maybe, 0),
    ];

    it('AllAttendees counts everyone', () => {
      expect(VoteResolver.countEligibleVoters(attendees, VoteEligibility.AllAttendees)).toBe(4);
    });

    it('ConfirmedOnly counts only Attending', () => {
      expect(VoteResolver.countEligibleVoters(attendees, VoteEligibility.ConfirmedOnly)).toBe(2);
    });

    it('PoolParticipants counts only those with available games', () => {
      expect(VoteResolver.countEligibleVoters(attendees, VoteEligibility.PoolParticipants)).toBe(2);
    });
  });

  describe('checkQuorum', () => {
    it('None always passes', () => {
      expect(
        VoteResolver.checkQuorum(0, 10, {
          voteQuorumType: VoteQuorumType.None,
          voteQuorumValue: null,
        }),
      ).toBe(true);
    });

    it('FixedCount passes when enough votes', () => {
      expect(
        VoteResolver.checkQuorum(3, 10, {
          voteQuorumType: VoteQuorumType.FixedCount,
          voteQuorumValue: 3,
        }),
      ).toBe(true);
    });

    it('FixedCount fails when not enough votes', () => {
      expect(
        VoteResolver.checkQuorum(2, 10, {
          voteQuorumType: VoteQuorumType.FixedCount,
          voteQuorumValue: 3,
        }),
      ).toBe(false);
    });

    it('PercentOfAttendees passes at 50% threshold', () => {
      expect(
        VoteResolver.checkQuorum(5, 10, {
          voteQuorumType: VoteQuorumType.PercentOfAttendees,
          voteQuorumValue: 50,
        }),
      ).toBe(true);
    });

    it('PercentOfAttendees fails below threshold', () => {
      expect(
        VoteResolver.checkQuorum(4, 10, {
          voteQuorumType: VoteQuorumType.PercentOfAttendees,
          voteQuorumValue: 50,
        }),
      ).toBe(false);
    });

    it('PercentOfAttendees fails with zero eligible', () => {
      expect(
        VoteResolver.checkQuorum(1, 0, {
          voteQuorumType: VoteQuorumType.PercentOfAttendees,
          voteQuorumValue: 50,
        }),
      ).toBe(false);
    });
  });

  describe('checkThreshold', () => {
    describe('SimpleMajority', () => {
      const policy = {
        voteThresholdType: VoteThresholdType.SimpleMajority,
        voteThresholdValue: null,
      };

      it('passes when >50% are For', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 3, againstCount: 2, interestedCount: 0, totalVotes: 5 }, 5, policy),
        ).toBe(true);
      });

      it('fails at exactly 50%', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 2, againstCount: 2, interestedCount: 0, totalVotes: 4 }, 4, policy),
        ).toBe(false);
      });

      it('fails with zero votes', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 0, againstCount: 0, interestedCount: 0, totalVotes: 0 }, 5, policy),
        ).toBe(false);
      });
    });

    describe('Supermajority', () => {
      it('passes when ≥66% are For', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 7, againstCount: 3, interestedCount: 0, totalVotes: 10 }, 10, {
            voteThresholdType: VoteThresholdType.Supermajority,
            voteThresholdValue: 66,
          }),
        ).toBe(true);
      });

      it('fails below 66%', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 6, againstCount: 4, interestedCount: 0, totalVotes: 10 }, 10, {
            voteThresholdType: VoteThresholdType.Supermajority,
            voteThresholdValue: 66,
          }),
        ).toBe(false);
      });
    });

    describe('Unanimous', () => {
      it('passes when all eligible voters vote For', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 5, againstCount: 0, interestedCount: 0, totalVotes: 5 }, 5, {
            voteThresholdType: VoteThresholdType.Unanimous,
            voteThresholdValue: null,
          }),
        ).toBe(true);
      });

      it('fails with any Against vote', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 4, againstCount: 1, interestedCount: 0, totalVotes: 5 }, 5, {
            voteThresholdType: VoteThresholdType.Unanimous,
            voteThresholdValue: null,
          }),
        ).toBe(false);
      });

      it('fails when not all eligible voters have voted For', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 3, againstCount: 0, interestedCount: 0, totalVotes: 3 }, 5, {
            voteThresholdType: VoteThresholdType.Unanimous,
            voteThresholdValue: null,
          }),
        ).toBe(false);
      });
    });

    describe('FixedCount', () => {
      it('passes when For count meets threshold', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 3, againstCount: 7, interestedCount: 0, totalVotes: 10 }, 10, {
            voteThresholdType: VoteThresholdType.FixedCount,
            voteThresholdValue: 3,
          }),
        ).toBe(true);
      });

      it('fails when For count is below threshold', () => {
        expect(
          VoteResolver.checkThreshold({ forCount: 2, againstCount: 8, interestedCount: 0, totalVotes: 10 }, 10, {
            voteThresholdType: VoteThresholdType.FixedCount,
            voteThresholdValue: 3,
          }),
        ).toBe(false);
      });
    });
  });

  describe('resolve', () => {
    it('returns Passed for simple majority with quorum met', () => {
      const result = VoteResolver.resolve(votes(VoteType.For, VoteType.For, VoteType.Against), makePolicy(), [
        makeAttendee(),
        makeAttendee(),
        makeAttendee(),
      ]);

      expect(result.status).toBe(NominationStatus.Passed);
      expect(result.quorumMet).toBe(true);
      expect(result.thresholdMet).toBe(true);
    });

    it('returns Failed when majority votes Against', () => {
      const result = VoteResolver.resolve(votes(VoteType.For, VoteType.Against, VoteType.Against), makePolicy(), [
        makeAttendee(),
        makeAttendee(),
        makeAttendee(),
      ]);

      expect(result.status).toBe(NominationStatus.Failed);
      expect(result.thresholdMet).toBe(false);
    });

    it('returns QuorumNotMet when not enough voters participate', () => {
      const result = VoteResolver.resolve(
        votes(VoteType.For),
        makePolicy({
          voteQuorumType: VoteQuorumType.FixedCount,
          voteQuorumValue: 3,
        }),
        [makeAttendee(), makeAttendee(), makeAttendee(), makeAttendee()],
      );

      expect(result.status).toBe(NominationStatus.QuorumNotMet);
      expect(result.quorumMet).toBe(false);
    });

    it('InterestedWeight.AsFor tips an otherwise tied vote to Passed', () => {
      // 1 For, 1 Against, 1 Interested → with AsFor: 2 For, 1 Against
      const result = VoteResolver.resolve(
        votes(VoteType.For, VoteType.Against, VoteType.Interested),
        makePolicy({ interestedWeight: InterestedWeight.AsFor }),
        [makeAttendee(), makeAttendee(), makeAttendee()],
      );

      expect(result.status).toBe(NominationStatus.Passed);
      expect(result.tally.forCount).toBe(2);
    });

    it('InterestedWeight.AsAgainst tips an otherwise tied vote to Failed', () => {
      // 1 For, 1 Against, 1 Interested → with AsAgainst: 1 For, 2 Against
      const result = VoteResolver.resolve(
        votes(VoteType.For, VoteType.Against, VoteType.Interested),
        makePolicy({ interestedWeight: InterestedWeight.AsAgainst }),
        [makeAttendee(), makeAttendee(), makeAttendee()],
      );

      expect(result.status).toBe(NominationStatus.Failed);
      expect(result.tally.againstCount).toBe(2);
    });

    it('uses ConfirmedOnly eligibility for eligible voter count', () => {
      const result = VoteResolver.resolve(
        votes(VoteType.For, VoteType.For),
        makePolicy({
          voteEligibility: VoteEligibility.ConfirmedOnly,
          voteThresholdType: VoteThresholdType.Unanimous,
        }),
        [
          makeAttendee(EventParticipationStatus.Attending),
          makeAttendee(EventParticipationStatus.Attending),
          makeAttendee(EventParticipationStatus.Invited), // not eligible
        ],
      );

      // 2 For out of 2 eligible = unanimous
      expect(result.eligibleVoterCount).toBe(2);
      expect(result.status).toBe(NominationStatus.Passed);
    });

    it('uses PoolParticipants eligibility', () => {
      const result = VoteResolver.resolve(
        votes(VoteType.For),
        makePolicy({
          voteEligibility: VoteEligibility.PoolParticipants,
          voteThresholdType: VoteThresholdType.Unanimous,
        }),
        [
          makeAttendee(EventParticipationStatus.Attending, 2), // eligible
          makeAttendee(EventParticipationStatus.Attending, 0), // not eligible (no games)
        ],
      );

      expect(result.eligibleVoterCount).toBe(1);
      expect(result.status).toBe(NominationStatus.Passed);
    });
  });
});

function makePolicy(overrides: Partial<VotingPolicy> = {}): VotingPolicy {
  return {
    voteThresholdType: VoteThresholdType.SimpleMajority,
    voteThresholdValue: null,
    voteQuorumType: VoteQuorumType.None,
    voteQuorumValue: null,
    voteEligibility: VoteEligibility.AllAttendees,
    interestedWeight: InterestedWeight.AsAbstain,
    ...overrides,
  };
}

function makeAttendee(status: EventParticipationStatus = EventParticipationStatus.Attending, gameCount = 0) {
  return {
    status,
    availableGames: Array.from({ length: gameCount }, (_, i) => ({
      id: `gl-${i}`,
    })),
  };
}

function votes(...types: VoteType[]) {
  return types.map((voteType) => ({ voteType }));
}
