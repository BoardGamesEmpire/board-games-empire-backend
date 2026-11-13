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

/** The policy a nomination is held to: its date's, where the date sets a field, else the event's. */
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

/**
 * Refuses voting rules a resolve could not apply: a Supermajority or
 * FixedCount threshold, or a PercentOfAttendees or FixedCount quorum, with no
 * number to count against. Judge the policy a write leaves, the stored policy
 * merged with the patch and folded under each date's overrides, not the patch
 * alone (#796).
 */
export function assertValidVotingRules(
  rules: Pick<EffectivePolicy, 'voteThresholdType' | 'voteThresholdValue' | 'voteQuorumType' | 'voteQuorumValue'>,
): void {
  if (THRESHOLD_TYPES_WITH_VALUE.includes(rules.voteThresholdType) && rules.voteThresholdValue === null) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_POLICY_INVALID',
      t('errors.event_policy.threshold_value_required'),
    );
  }

  if (QUORUM_TYPES_WITH_VALUE.includes(rules.voteQuorumType) && rules.voteQuorumValue === null) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_POLICY_INVALID',
      t('errors.event_policy.quorum_value_required'),
    );
  }
}
