import { InviteStatus } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { inviteNotOutstanding } from './invite-refusals';

// Literal on purpose: reading the expected key from the map under test would
// let two swapped entries pass.
const EXPECTED_KEYS = [
  [InviteStatus.Pending, 'errors.invite.state.pending'],
  [InviteStatus.AwaitingApproval, 'errors.invite.state.awaiting_approval'],
  [InviteStatus.Accepted, 'errors.invite.state.accepted'],
  [InviteStatus.Declined, 'errors.invite.state.declined'],
  [InviteStatus.Expired, 'errors.invite.state.expired'],
  [InviteStatus.Revoked, 'errors.invite.state.revoked'],
  [InviteStatus.Withdrawn, 'errors.invite.state.withdrawn'],
] as const;

describe('inviteNotOutstanding (#1114)', () => {
  it('covers every InviteStatus in the table below', () => {
    expect(EXPECTED_KEYS.map(([status]) => status).sort()).toEqual(Object.values(InviteStatus).sort());
  });

  it.each(EXPECTED_KEYS)('refuses a %s invite with a 409 code, the status and its own sentence', (status, key) => {
    const refusal = inviteNotOutstanding(status);

    expect(refusal).toBeInstanceOf(CodedHttpException);
    expect(refusal.getStatus()).toBe(409);
    expect(refusal.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: t(key),
      code: 'INVITE_NOT_OUTSTANDING',
      state: status,
    });
  });
});
