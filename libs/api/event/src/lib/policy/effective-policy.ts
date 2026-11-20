import type { EventOccurrencePolicy, EventPolicy } from '@bge/database';
import { GameAdditionMode, InterestedWeight, VoteEligibility, VoteQuorumType, VoteThresholdType } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';
import type { CreateEventPolicyDto } from '../dto/create-event-policy.dto';
import type { VotingPolicy } from '../interfaces/vote.interface';

export type EffectivePolicy = VotingPolicy & { gameAdditionMode: GameAdditionMode; votingWindowHours: number | null };

/**
 * A date's effective policy: the date's value for each field it sets, else the
 * event's, else the schema's default. A nomination is held to it, and a policy
 * write is judged by it for each date the event has (#796). It reads only the
 * fields it folds, so a date's policy as a write would leave it, before its
 * row exists, folds too.
 */
export function foldPolicy(
  eventPolicy: EventPolicy | null,
  occPolicy: Pick<EventOccurrencePolicy, keyof EffectivePolicy> | null,
): EffectivePolicy {
  const base = {
    gameAdditionMode: eventPolicy?.gameAdditionMode ?? GameAdditionMode.Direct,
    voteThresholdType: eventPolicy?.voteThresholdType ?? VoteThresholdType.SimpleMajority,
    voteThresholdValue: eventPolicy?.voteThresholdValue ?? null,
    voteQuorumType: eventPolicy?.voteQuorumType ?? VoteQuorumType.None,
    voteQuorumValue: eventPolicy?.voteQuorumValue ?? null,
    voteEligibility: eventPolicy?.voteEligibility ?? VoteEligibility.ConfirmedOnly,
    interestedWeight: eventPolicy?.interestedWeight ?? InterestedWeight.AsAbstain,
    votingWindowHours: eventPolicy?.votingWindowHours ?? null,
  };

  if (!occPolicy) {
    return base;
  }

  return {
    gameAdditionMode: occPolicy.gameAdditionMode ?? base.gameAdditionMode,
    voteThresholdType: occPolicy.voteThresholdType ?? base.voteThresholdType,
    voteThresholdValue: occPolicy.voteThresholdValue ?? base.voteThresholdValue,
    voteQuorumType: occPolicy.voteQuorumType ?? base.voteQuorumType,
    voteQuorumValue: occPolicy.voteQuorumValue ?? base.voteQuorumValue,
    voteEligibility: occPolicy.voteEligibility ?? base.voteEligibility,
    interestedWeight: occPolicy.interestedWeight ?? base.interestedWeight,
    votingWindowHours: occPolicy.votingWindowHours ?? base.votingWindowHours,
  };
}

/** The threshold types that count against a number the policy must hold. */
const THRESHOLD_TYPES_WITH_VALUE: readonly VoteThresholdType[] = [
  VoteThresholdType.Supermajority,
  VoteThresholdType.FixedCount,
];

/** The quorum types that count against a number the policy must hold. */
const QUORUM_TYPES_WITH_VALUE: readonly VoteQuorumType[] = [
  VoteQuorumType.PercentOfAttendees,
  VoteQuorumType.FixedCount,
];

/** The largest percentage a Supermajority threshold or PercentOfAttendees quorum can ask for. */
export const MAX_PERCENT = 100;

/**
 * The smallest percentage a Supermajority threshold can ask for: more than
 * half of the votes, or it is no supermajority (#1274).
 */
export const MIN_SUPERMAJORITY_PERCENT = 51;

/**
 * Refuses a voting policy a resolve could not apply: a Supermajority or
 * FixedCount threshold, or a PercentOfAttendees or FixedCount quorum, with no
 * number to count against, or a percentage above 100, which no vote can reach.
 * A Supermajority also asks for more than half of the votes (#1274).
 *
 * Judge the policy a write leaves, the stored policy merged with the patch and
 * folded under each date's overrides, not the patch alone (#796). A fold can
 * turn an event's fixed count into a date's percentage, so the bounds are
 * checked on the folded policy, not on the field.
 *
 * `fields` rides on a refusal, so a refusal of a date's folded policy names the
 * date (`occurrenceIds`), as the override scope's refusal does.
 */
export function assertValidVotingPolicy(
  policy: Pick<EffectivePolicy, 'voteThresholdType' | 'voteThresholdValue' | 'voteQuorumType' | 'voteQuorumValue'>,
  fields?: Readonly<Record<string, unknown>>,
): void {
  const refuse = (message: ReturnType<typeof t>) =>
    new CodedHttpException(Http.BadRequest, 'EVENT_POLICY_INVALID', message, { fields });

  if (THRESHOLD_TYPES_WITH_VALUE.includes(policy.voteThresholdType) && policy.voteThresholdValue === null) {
    throw refuse(t('errors.event_policy.threshold_value_required'));
  }

  if (
    policy.voteThresholdType === VoteThresholdType.Supermajority &&
    policy.voteThresholdValue !== null &&
    policy.voteThresholdValue < MIN_SUPERMAJORITY_PERCENT
  ) {
    throw refuse(
      t('errors.event_policy.threshold_percent_too_low', { min: MIN_SUPERMAJORITY_PERCENT, max: MAX_PERCENT }),
    );
  }

  if (
    policy.voteThresholdType === VoteThresholdType.Supermajority &&
    policy.voteThresholdValue !== null &&
    policy.voteThresholdValue > MAX_PERCENT
  ) {
    throw refuse(
      t('errors.event_policy.threshold_percent_too_high', { min: MIN_SUPERMAJORITY_PERCENT, max: MAX_PERCENT }),
    );
  }

  if (QUORUM_TYPES_WITH_VALUE.includes(policy.voteQuorumType) && policy.voteQuorumValue === null) {
    throw refuse(t('errors.event_policy.quorum_value_required'));
  }

  if (
    policy.voteQuorumType === VoteQuorumType.PercentOfAttendees &&
    policy.voteQuorumValue !== null &&
    policy.voteQuorumValue > MAX_PERCENT
  ) {
    throw refuse(t('errors.event_policy.quorum_percent_too_high', { max: MAX_PERCENT }));
  }
}

/**
 * Refuses the voting policy an event is created with on the same terms as a
 * policy edit (#1274): the fields sent, over the schema's defaults for the
 * fields left out. Its dates start with empty policies, so the event's own is
 * the only one to judge.
 */
export function assertValidCreatedVotingPolicy(
  policy:
    | Pick<CreateEventPolicyDto, 'voteThresholdType' | 'voteThresholdValue' | 'voteQuorumType' | 'voteQuorumValue'>
    | undefined,
): void {
  // An event with no policy row folds to the schema's defaults.
  const schemaDefaults = foldPolicy(null, null);
  const sent = policy ?? {};

  // A number sent as null stays null, so it is judged as no number rather
  // than taking a default.
  assertValidVotingPolicy({
    voteThresholdType: sent.voteThresholdType ?? schemaDefaults.voteThresholdType,
    voteThresholdValue:
      sent.voteThresholdValue === undefined ? schemaDefaults.voteThresholdValue : sent.voteThresholdValue,
    voteQuorumType: sent.voteQuorumType ?? schemaDefaults.voteQuorumType,
    voteQuorumValue: sent.voteQuorumValue === undefined ? schemaDefaults.voteQuorumValue : sent.voteQuorumValue,
  });
}
