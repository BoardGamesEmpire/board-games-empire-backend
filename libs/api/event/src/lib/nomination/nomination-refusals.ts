import { GameAdditionMode, NominationStatus } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { CodedHttpException, t } from '@bge/i18n';
import { NotFoundException } from '@nestjs/common';
import { Http } from '@status/codes';

/** What the actor asked of a nomination its status refuses, as the refusal's stable code (#1114). */
export type NominationStatusRefusalCode =
  | 'NOMINATION_NOT_WITHDRAWABLE'
  | 'NOMINATION_NOT_OPEN'
  | 'NOMINATION_NOT_RESOLVABLE'
  | 'NOMINATION_NOT_AWAITING_APPROVAL';

/**
 * The sentence each nomination status reads as in a refusal. Each status gets
 * a whole translatable sentence, rather than its enum name dropped into a
 * shared frame, which a reader would hear as code (#1114).
 */
const NOMINATION_STATE_MESSAGE = {
  [NominationStatus.Open]: 'errors.nomination.state.open',
  [NominationStatus.AwaitingApproval]: 'errors.nomination.state.awaiting_approval',
  [NominationStatus.Approved]: 'errors.nomination.state.decided',
  [NominationStatus.Passed]: 'errors.nomination.state.decided',
  [NominationStatus.Failed]: 'errors.nomination.state.decided',
  [NominationStatus.QuorumNotMet]: 'errors.nomination.state.decided',
  [NominationStatus.Rejected]: 'errors.nomination.state.decided',
  [NominationStatus.Paused]: 'errors.nomination.state.paused',
  [NominationStatus.Withdrawn]: 'errors.nomination.state.withdrawn',
} as const satisfies Record<NominationStatus, I18nPath>;

/** The 404 for a nomination that isn't in the event, whether never there or removed since it was read (#1114). */
export function nominationNotFound(nominationId: string, eventId: string): NotFoundException {
  return new NotFoundException(t('errors.nomination.not_found', { nominationId, eventId }));
}

/**
 * A 400 for a nomination whose status refuses the request. The code names
 * what was refused, the message says the state the nomination is in, and
 * `status` carries the status a client can branch on (#1114).
 */
export function nominationStatusRefusal(
  code: NominationStatusRefusalCode,
  status: NominationStatus,
): CodedHttpException {
  return new CodedHttpException(Http.BadRequest, code, t(NOMINATION_STATE_MESSAGE[status]), { fields: { status } });
}

/** The game addition modes under which a game can't be added straight to the lineup (#1114). */
export type RefusedAdditionMode = Exclude<GameAdditionMode, 'Direct' | 'HostOnly'>;

/** What to do instead, for each mode that chooses games by nomination (#1114). */
const DIRECT_ADD_MESSAGE = {
  [GameAdditionMode.RequiresVote]: 'errors.nomination.direct_add.requires_vote',
  [GameAdditionMode.HostApproval]: 'errors.nomination.direct_add.host_approval',
} as const satisfies Record<RefusedAdditionMode, I18nPath>;

/** A 403 for a direct add under a mode that chooses games by nomination, the mode kept as a field (#1114). */
export function directAddRefusal(mode: RefusedAdditionMode): CodedHttpException {
  return new CodedHttpException(Http.Forbidden, 'GAME_ADDITION_NOT_DIRECT', t(DIRECT_ADD_MESSAGE[mode]), {
    fields: { mode },
  });
}
