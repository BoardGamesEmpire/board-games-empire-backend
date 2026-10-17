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
import { VoteResolver, type AttendeeStub } from './vote-resolver';

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

    // #551: an attendee who is out of the event, removed by a host or not
    // attending, is no voter under any rule.
    it.each(Object.values(VoteEligibility))('%s counts no one who is out of the event', (eligibility) => {
      const out = [
        makeAttendee(EventParticipationStatus.NotAttending, 1),
        { ...makeAttendee(EventParticipationStatus.Attending, 1), removedAt: new Date() },
      ];

      expect(VoteResolver.countEligibleVoters([...attendees, ...out], eligibility)).toBe(
        VoteResolver.countEligibleVoters(attendees, eligibility),
      );
    });
  });

  describe('isEligibleVoter', () => {
    it.each([
      [VoteEligibility.AllAttendees, EventParticipationStatus.Invited, 0, true],
      [VoteEligibility.AllAttendees, EventParticipationStatus.Maybe, 0, true],
      [VoteEligibility.AllAttendees, EventParticipationStatus.NotAttending, 0, false],
      [VoteEligibility.ConfirmedOnly, EventParticipationStatus.Attending, 0, true],
      [VoteEligibility.ConfirmedOnly, EventParticipationStatus.Invited, 0, false],
      [VoteEligibility.ConfirmedOnly, EventParticipationStatus.Maybe, 0, false],
      [VoteEligibility.PoolParticipants, EventParticipationStatus.Maybe, 1, true],
      [VoteEligibility.PoolParticipants, EventParticipationStatus.Attending, 0, false],
      [VoteEligibility.PoolParticipants, EventParticipationStatus.NotAttending, 1, false],
    ])('%s: status %s, %i listed games → eligible %s', (eligibility, status, gameCount, expected) => {
      expect(VoteResolver.isEligibleVoter(makeAttendee(status, gameCount), eligibility)).toBe(expected);
    });

    it.each(Object.values(VoteEligibility))('%s: an attendee a host removed is not eligible', (eligibility) => {
      const removed = { ...makeAttendee(EventParticipationStatus.Attending, 1), removedAt: new Date() };

      expect(VoteResolver.isEligibleVoter(removed, eligibility)).toBe(false);
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
      const participant = makeAttendee(EventParticipationStatus.Attending, 2); // eligible
      const result = VoteResolver.resolve(
        [vote(VoteType.For, participant)],
        makePolicy({
          voteEligibility: VoteEligibility.PoolParticipants,
          voteThresholdType: VoteThresholdType.Unanimous,
        }),
        [
          participant,
          makeAttendee(EventParticipationStatus.Attending, 0), // not eligible (no games)
        ],
      );

      expect(result.eligibleVoterCount).toBe(1);
      expect(result.status).toBe(NominationStatus.Passed);
    });

    // #551. The votes were counted whoever cast them, while quorum counted
    // only the eligible: under ConfirmedOnly a voter who had since declined
    // still swung the result.
    it('counts no vote from a voter who is not eligible, and keeps the tally to the votes it counted', () => {
      const result = VoteResolver.resolve(
        [
          vote(VoteType.For, makeAttendee(EventParticipationStatus.Attending)),
          vote(VoteType.Against, makeAttendee(EventParticipationStatus.Attending)),
          vote(VoteType.For, makeAttendee(EventParticipationStatus.NotAttending)),
          vote(VoteType.For, makeAttendee(EventParticipationStatus.Invited)),
        ],
        makePolicy({ voteEligibility: VoteEligibility.ConfirmedOnly }),
        [makeAttendee(), makeAttendee()],
      );

      expect(result.tally).toEqual({ forCount: 1, againstCount: 1, interestedCount: 0, totalVotes: 2 });
      expect(result.status).toBe(NominationStatus.Failed);
    });

    it('counts no vote from a voter a host removed', () => {
      const removed = { ...makeAttendee(), removedAt: new Date() };
      const result = VoteResolver.resolve(
        [vote(VoteType.Against, makeAttendee()), vote(VoteType.For, removed), vote(VoteType.For, removed)],
        makePolicy(),
        [makeAttendee()],
      );

      expect(result.tally.totalVotes).toBe(1);
      expect(result.status).toBe(NominationStatus.Failed);
    });

    it('counts the same vote once its voter is back in', () => {
      const voter = makeAttendee(EventParticipationStatus.NotAttending);
      const ballot = [vote(VoteType.For, voter)];
      const policy = makePolicy({ voteQuorumType: VoteQuorumType.FixedCount, voteQuorumValue: 1 });

      expect(VoteResolver.resolve(ballot, policy, [voter]).status).toBe(NominationStatus.QuorumNotMet);

      voter.status = EventParticipationStatus.Attending;

      expect(VoteResolver.resolve(ballot, policy, [voter]).status).toBe(NominationStatus.Passed);
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

function makeAttendee(
  status: EventParticipationStatus = EventParticipationStatus.Attending,
  gameCount = 0,
): AttendeeStub {
  return {
    status,
    removedAt: null,
    availableGames: Array.from({ length: gameCount }, (_, i) => ({
      id: `gl-${i}`,
    })),
  };
}

function vote(voteType: VoteType, voter: AttendeeStub) {
  return { voteType, voter };
}

/** Votes cast by attendees who are in and eligible under every rule but PoolParticipants. */
function votes(...types: VoteType[]) {
  return types.map((voteType) => vote(voteType, makeAttendee()));
}
