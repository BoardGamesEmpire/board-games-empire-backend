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
import { assertValidVotingRules, foldPolicy } from './policy-rules';

/** The error `run` throws, or a failure when it throws none. */
function refusalOf(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  throw new Error('expected a refusal, but the voting rules were accepted');
}

describe('foldPolicy', () => {
  it("serves the schema's defaults when neither the event nor the date has a policy row", () => {
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

  it("serves the event's policy when the date has no row of its own", () => {
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

  // A date's null means "the event's rule", so only the fields it sets win.
  it("takes the date's value for a field it sets and the event's for a field it leaves null", () => {
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

describe('assertValidVotingRules', () => {
  const rules = (overrides: Partial<Parameters<typeof assertValidVotingRules>[0]> = {}) => ({
    voteThresholdType: VoteThresholdType.SimpleMajority,
    voteThresholdValue: null,
    voteQuorumType: VoteQuorumType.None,
    voteQuorumValue: null,
    ...overrides,
  });

  // A Supermajority with no percentage has no line a vote can pass (#796).
  it('refuses a Supermajority threshold with no value', () => {
    expect(
      refusalOf(() => assertValidVotingRules(rules({ voteThresholdType: VoteThresholdType.Supermajority }))),
    ).toMatchObject({
      status: 400,
      response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.threshold_value_required') },
    });
  });

  it('refuses a PercentOfAttendees quorum with no value', () => {
    expect(
      refusalOf(() => assertValidVotingRules(rules({ voteQuorumType: VoteQuorumType.PercentOfAttendees }))),
    ).toMatchObject({
      status: 400,
      response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.quorum_value_required') },
    });
  });

  // Each type in a list needs its own case: dropping one from the list in
  // `policy-rules.ts` would otherwise pass every test (#796).
  it.each([VoteThresholdType.Supermajority, VoteThresholdType.FixedCount])(
    'refuses a %s threshold with no value',
    (voteThresholdType) => {
      expect(refusalOf(() => assertValidVotingRules(rules({ voteThresholdType })))).toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.threshold_value_required') },
      });
    },
  );

  it.each([VoteQuorumType.PercentOfAttendees, VoteQuorumType.FixedCount])(
    'refuses a %s quorum with no value',
    (voteQuorumType) => {
      expect(refusalOf(() => assertValidVotingRules(rules({ voteQuorumType })))).toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.quorum_value_required') },
      });
    },
  );

  it('accepts a SimpleMajority threshold with no value, which needs none', () => {
    expect(() => assertValidVotingRules(rules())).not.toThrow();
  });
});
