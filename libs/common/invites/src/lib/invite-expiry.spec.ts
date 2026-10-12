import { InviteStatus } from '@bge/database';
import { effectiveInviteStatus, isOutstandingInviteStatus, withEffectiveInviteStatus } from './invite-expiry';

const NOW = new Date('2026-10-12T12:00:00Z');
const PAST = new Date('2026-10-12T11:59:59Z');
const FUTURE = new Date('2026-10-12T12:00:01Z');

describe('invite expiry', () => {
  describe('isOutstandingInviteStatus', () => {
    it.each([InviteStatus.Pending, InviteStatus.AwaitingApproval])('%s is outstanding', (status) => {
      expect(isOutstandingInviteStatus(status)).toBe(true);
    });

    it.each([
      InviteStatus.Accepted,
      InviteStatus.Declined,
      InviteStatus.Expired,
      InviteStatus.Revoked,
      InviteStatus.Withdrawn,
    ])('%s is terminal', (status) => {
      expect(isOutstandingInviteStatus(status)).toBe(false);
    });
  });

  describe('effectiveInviteStatus', () => {
    it('reports an outstanding row past its date as Expired without touching it', () => {
      expect(effectiveInviteStatus({ status: InviteStatus.Pending, expiresAt: PAST }, NOW)).toBe(InviteStatus.Expired);
      expect(effectiveInviteStatus({ status: InviteStatus.AwaitingApproval, expiresAt: PAST }, NOW)).toBe(
        InviteStatus.Expired,
      );
    });

    it('expires at the boundary: an invite whose date IS now is no longer open', () => {
      expect(effectiveInviteStatus({ status: InviteStatus.Pending, expiresAt: NOW }, NOW)).toBe(InviteStatus.Expired);
    });

    it('leaves an outstanding row inside its window alone', () => {
      expect(effectiveInviteStatus({ status: InviteStatus.Pending, expiresAt: FUTURE }, NOW)).toBe(
        InviteStatus.Pending,
      );
    });

    it('never expires a settled row, whatever the clock says', () => {
      // A declined invite past its date is still declined. Reporting it as
      // expired would rewrite history a listener already acted on.
      for (const status of [
        InviteStatus.Accepted,
        InviteStatus.Declined,
        InviteStatus.Revoked,
        InviteStatus.Withdrawn,
        InviteStatus.Expired,
      ]) {
        expect(effectiveInviteStatus({ status, expiresAt: PAST }, NOW)).toBe(status);
      }
    });
  });

  describe('withEffectiveInviteStatus', () => {
    it('returns the same object when nothing changes', () => {
      const invite = { id: 'inv-1', status: InviteStatus.Pending, expiresAt: FUTURE };

      expect(withEffectiveInviteStatus(invite, NOW)).toBe(invite);
    });

    it('returns a copy with the computed status, keeping every other field', () => {
      const invite = { id: 'inv-1', status: InviteStatus.Pending, expiresAt: PAST, inviteeName: 'Sam' };

      const effective = withEffectiveInviteStatus(invite, NOW);

      expect(effective).toEqual({ ...invite, status: InviteStatus.Expired });
      expect(invite.status).toBe(InviteStatus.Pending);
    });
  });
});
