import {
  GameAdditionMode,
  InterestedWeight,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
  type EventOccurrencePolicy,
} from '@bge/database';
import { t } from '@bge/i18n';
import { makeEventPolicy } from '@bge/testing';
import { assertValidVotingPolicy, foldPolicy } from './effective-policy';

/** The error `run` throws, or a failure when it throws none. */
function refusalOf(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('expected a refusal, but the voting policy was accepted');
}

describe('foldPolicy', () => {
  it("serves the schema's defaults when neither the event nor the date has a policy row (#796)", () => {
    expect(foldPolicy(null, null)).toEqual({
      gameAdditionMode: GameAdditionMode.Direct,
      voteThresholdType: VoteThresholdType.SimpleMajority,
      voteThresholdValue: null,
      voteQuorumType: VoteQuorumType.None,
      voteQuorumValue: null,
      voteEligibility: VoteEligibility.ConfirmedOnly,
      interestedWeight: InterestedWeight.AsAbstain,
      votingWindowHours: null,
    });
  });

  it("serves the event's policy when the date has no row of its own (#796)", () => {
    const eventPolicy = makeEventPolicy('event-1', {
      gameAdditionMode: GameAdditionMode.RequiresVote,
      voteThresholdType: VoteThresholdType.Supermajority,
      voteThresholdValue: 66,
      votingWindowHours: 48,
    });

    expect(foldPolicy(eventPolicy, null)).toEqual(
      expect.objectContaining({
        gameAdditionMode: GameAdditionMode.RequiresVote,
        voteThresholdType: VoteThresholdType.Supermajority,
        voteThresholdValue: 66,
        votingWindowHours: 48,
      }),
    );
  });

  // A date's null means "the event's value", so only the fields it sets win.
  it("takes the date's value for a field it sets and the event's for a field it leaves null (#796)", () => {
    const eventPolicy = makeEventPolicy('event-1', {
      voteEligibility: VoteEligibility.ConfirmedOnly,
      voteThresholdType: VoteThresholdType.Supermajority,
      voteThresholdValue: 66,
    });
    const datePolicy = {
      occurrenceId: 'occ-1',
      voteEligibility: VoteEligibility.AllAttendees,
      voteThresholdType: null,
      voteThresholdValue: null,
    } as EventOccurrencePolicy;

    expect(foldPolicy(eventPolicy, datePolicy)).toEqual(
      expect.objectContaining({
        voteEligibility: VoteEligibility.AllAttendees,
        voteThresholdType: VoteThresholdType.Supermajority,
        voteThresholdValue: 66,
      }),
    );
  });
});

describe('assertValidVotingPolicy', () => {
  const votingPolicy = (overrides: Partial<Parameters<typeof assertValidVotingPolicy>[0]> = {}) => ({
    voteThresholdType: VoteThresholdType.SimpleMajority,
    voteThresholdValue: null,
    voteQuorumType: VoteQuorumType.None,
    voteQuorumValue: null,
    ...overrides,
  });

  // A threshold or quorum counted against a number has no line a vote can
  // pass without one. Each type in a list needs its own case: dropping one
  // from the list in `effective-policy.ts` would otherwise pass every test.
  it.each([VoteThresholdType.Supermajority, VoteThresholdType.FixedCount])(
    'refuses a %s threshold with no value (#796)',
    (voteThresholdType) => {
      expect(refusalOf(() => assertValidVotingPolicy(votingPolicy({ voteThresholdType })))).toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.threshold_value_required') },
      });
    },
  );

  it.each([VoteQuorumType.PercentOfAttendees, VoteQuorumType.FixedCount])(
    'refuses a %s quorum with no value (#796)',
    (voteQuorumType) => {
      expect(refusalOf(() => assertValidVotingPolicy(votingPolicy({ voteQuorumType })))).toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.quorum_value_required') },
      });
    },
  );

  it('accepts a SimpleMajority threshold with no value, which needs none (#796)', () => {
    expect(() => assertValidVotingPolicy(votingPolicy())).not.toThrow();
  });
});
