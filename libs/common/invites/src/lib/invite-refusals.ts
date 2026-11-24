import { InviteStatus } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

/**
 * One sentence per status (#1114): the refusal names what state the invite is
 * in, in words, rather than interpolating the enum's name into a frame.
 */
const INVITE_STATE_MESSAGE = {
  [InviteStatus.Pending]: 'errors.invite.state.pending',
  [InviteStatus.AwaitingApproval]: 'errors.invite.state.awaiting_approval',
  [InviteStatus.Accepted]: 'errors.invite.state.accepted',
  [InviteStatus.Declined]: 'errors.invite.state.declined',
  [InviteStatus.Expired]: 'errors.invite.state.expired',
  [InviteStatus.Revoked]: 'errors.invite.state.revoked',
  [InviteStatus.Withdrawn]: 'errors.invite.state.withdrawn',
} as const satisfies Record<InviteStatus, I18nPath>;

/**
 * The refusal for a transition an invite's status doesn't allow. The status is
 * the field `state` so a client can branch on it; the invite's id is not, since the
 * actor already holds it and a revoked answer must tell the invitee nothing
 * more (#1114).
 */
export function inviteNotOutstanding(status: InviteStatus): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'INVITE_NOT_OUTSTANDING', t(INVITE_STATE_MESSAGE[status]), {
    fields: { state: status },
  });
}
