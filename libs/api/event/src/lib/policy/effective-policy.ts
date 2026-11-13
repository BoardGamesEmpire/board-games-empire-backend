import {
  GameAdditionMode,
  InterestedWeight,
  VoteEligibility,
  VoteQuorumType,
  VoteThresholdType,
  type EventOccurrencePolicy,
  type EventPolicy,
} from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';
import type { VotingPolicy } from '../interfaces/vote.interface';

export type EffectivePolicy = VotingPolicy & { gameAdditionMode: GameAdditionMode; votingWindowHours: number | null };

/**
 * A date's effective policy: the date's value for each field it sets, else the
 * event's, else the schema's default. A nomination is held to it, and a policy
 * write is judged by it for each date the event has (#796).
 */
export function foldPolicy(eventPolicy: EventPolicy | null, occPolicy: EventOccurrencePolicy | null): EffectivePolicy {
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
const MAX_PERCENT = 100;

/**
 * Refuses a voting policy a resolve could not apply: a Supermajority or
 * FixedCount threshold, or a PercentOfAttendees or FixedCount quorum, with no
 * number to count against, or a percentage above 100, which no vote can reach.
 * Judge the policy a write leaves, the stored policy merged with the patch and
 * folded under each date's overrides, not the patch alone (#796). A fold can
 * turn an event's fixed count into a date's percentage, so the cap is checked
 * on the folded policy, not on the field.
 */
export function assertValidVotingPolicy(
  policy: Pick<EffectivePolicy, 'voteThresholdType' | 'voteThresholdValue' | 'voteQuorumType' | 'voteQuorumValue'>,
): void {
  if (THRESHOLD_TYPES_WITH_VALUE.includes(policy.voteThresholdType) && policy.voteThresholdValue === null) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_POLICY_INVALID',
      t('errors.event_policy.threshold_value_required'),
    );
  }

  if (
    policy.voteThresholdType === VoteThresholdType.Supermajority &&
    policy.voteThresholdValue !== null &&
    policy.voteThresholdValue > MAX_PERCENT
  ) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_POLICY_INVALID',
      t('errors.event_policy.threshold_percent_too_high'),
    );
  }

  if (QUORUM_TYPES_WITH_VALUE.includes(policy.voteQuorumType) && policy.voteQuorumValue === null) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_POLICY_INVALID',
      t('errors.event_policy.quorum_value_required'),
    );
  }

  if (
    policy.voteQuorumType === VoteQuorumType.PercentOfAttendees &&
    policy.voteQuorumValue !== null &&
    policy.voteQuorumValue > MAX_PERCENT
  ) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_POLICY_INVALID',
      t('errors.event_policy.quorum_percent_too_high'),
    );
  }
}
