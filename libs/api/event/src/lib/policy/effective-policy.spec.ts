import type { EventOccurrencePolicy } from '@bge/database';
import { GameAdditionMode, InterestedWeight, VoteEligibility, VoteQuorumType, VoteThresholdType } from '@bge/database';
import { t } from '@bge/i18n';
import { makeEventPolicy } from '@bge/testing';
import { assertValidCreatedVotingPolicy, assertValidVotingPolicy, foldPolicy } from './effective-policy';

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

  // No vote reaches more than all of the votes or all of the voters, so a
  // percentage above 100 would turn down every nomination without saying why.
  it('refuses a Supermajority threshold above 100 percent, and accepts 100 (#796)', () => {
    const supermajority = (voteThresholdValue: number) =>
      votingPolicy({ voteThresholdType: VoteThresholdType.Supermajority, voteThresholdValue });

    expect(refusalOf(() => assertValidVotingPolicy(supermajority(101)))).toMatchObject({
      status: 400,
      response: {
        code: 'EVENT_POLICY_INVALID',
        message: t('errors.event_policy.threshold_percent_too_high', { min: 51, max: 100 }),
      },
    });
    expect(() => assertValidVotingPolicy(supermajority(100))).not.toThrow();
  });

  // At or under half of the votes isn't a supermajority: two opposite
  // nominations could both pass (#1274).
  it('refuses a Supermajority threshold below 51 percent, and accepts 51 (#1274)', () => {
    const supermajority = (voteThresholdValue: number) =>
      votingPolicy({ voteThresholdType: VoteThresholdType.Supermajority, voteThresholdValue });

    expect(refusalOf(() => assertValidVotingPolicy(supermajority(50)))).toMatchObject({
      status: 400,
      response: {
        code: 'EVENT_POLICY_INVALID',
        message: t('errors.event_policy.threshold_percent_too_low', { min: 51, max: 100 }),
      },
    });
    expect(() => assertValidVotingPolicy(supermajority(51))).not.toThrow();
  });

  it('refuses a PercentOfAttendees quorum above 100 percent, and accepts 100 (#796)', () => {
    const percentQuorum = (voteQuorumValue: number) =>
      votingPolicy({ voteQuorumType: VoteQuorumType.PercentOfAttendees, voteQuorumValue });

    expect(refusalOf(() => assertValidVotingPolicy(percentQuorum(101)))).toMatchObject({
      status: 400,
      response: {
        code: 'EVENT_POLICY_INVALID',
        message: t('errors.event_policy.quorum_percent_too_high', { max: 100 }),
      },
    });
    expect(() => assertValidVotingPolicy(percentQuorum(100))).not.toThrow();
  });

  // A count isn't a percentage, so it has no ceiling of 100.
  it('accepts a FixedCount threshold and quorum above 100 (#796)', () => {
    expect(() =>
      assertValidVotingPolicy(
        votingPolicy({
          voteThresholdType: VoteThresholdType.FixedCount,
          voteThresholdValue: 150,
          voteQuorumType: VoteQuorumType.FixedCount,
          voteQuorumValue: 150,
        }),
      ),
    ).not.toThrow();
  });
});

// Create judges the policy it is sent as the policy edit judges the policy a
// patch leaves, over the schema's defaults (#1274).
describe('assertValidCreatedVotingPolicy (#1274)', () => {
  const refusalMessage = (policy: Parameters<typeof assertValidCreatedVotingPolicy>[0]) =>
    (refusalOf(() => assertValidCreatedVotingPolicy(policy)) as { response?: { message?: string } } | undefined)
      ?.response?.message;

  it('accepts an event created with no policy, which takes the defaults (#1274)', () => {
    expect(() => assertValidCreatedVotingPolicy(undefined)).not.toThrow();
    expect(() => assertValidCreatedVotingPolicy({})).not.toThrow();
  });

  it('refuses a Supermajority threshold sent with no number (#1274)', () => {
    expect(
      refusalOf(() => assertValidCreatedVotingPolicy({ voteThresholdType: VoteThresholdType.Supermajority })),
    ).toMatchObject({
      status: 400,
      response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.threshold_value_required') },
    });
  });

  it('refuses a Supermajority threshold sent with null, as with no number (#1274)', () => {
    expect(refusalMessage({ voteThresholdType: VoteThresholdType.Supermajority, voteThresholdValue: null })).toEqual(
      t('errors.event_policy.threshold_value_required'),
    );
  });

  it.each<[string, Parameters<typeof assertValidCreatedVotingPolicy>[0], ReturnType<typeof t>]>([
    [
      'a Supermajority above 100',
      { voteThresholdType: VoteThresholdType.Supermajority, voteThresholdValue: 101 },
      t('errors.event_policy.threshold_percent_too_high', { min: 51, max: 100 }),
    ],
    [
      'a Supermajority below 51',
      { voteThresholdType: VoteThresholdType.Supermajority, voteThresholdValue: 50 },
      t('errors.event_policy.threshold_percent_too_low', { min: 51, max: 100 }),
    ],
    [
      'a PercentOfAttendees quorum above 100',
      { voteQuorumType: VoteQuorumType.PercentOfAttendees, voteQuorumValue: 101 },
      t('errors.event_policy.quorum_percent_too_high', { max: 100 }),
    ],
    [
      'a FixedCount quorum with no number',
      { voteQuorumType: VoteQuorumType.FixedCount },
      t('errors.event_policy.quorum_value_required'),
    ],
  ])('refuses %s (#1274)', (_, policy, message) => {
    expect(refusalMessage(policy)).toEqual(message);
  });

  // The policy edit accepts a number its type doesn't read, so create does too.
  it('accepts a SimpleMajority threshold sent with a number it does not read (#1274)', () => {
    expect(() =>
      assertValidCreatedVotingPolicy({ voteThresholdType: VoteThresholdType.SimpleMajority, voteThresholdValue: 3 }),
    ).not.toThrow();
  });

  it('accepts a Supermajority of 51 (#1274)', () => {
    expect(() =>
      assertValidCreatedVotingPolicy({ voteThresholdType: VoteThresholdType.Supermajority, voteThresholdValue: 51 }),
    ).not.toThrow();
  });
});
