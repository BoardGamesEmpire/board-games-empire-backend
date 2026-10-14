import { InviteStatus, type Prisma } from '@bge/database';
import {
  effectiveInviteStatus,
  effectiveInviteStatusWhere,
  isOutstandingInviteStatus,
  unexpiredInviteWhere,
  withEffectiveInviteStatus,
} from './invite-expiry';

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

  describe('unexpiredInviteWhere', () => {
    it('keeps the rows whose window is still open, excluding one that closes exactly now', () => {
      // `gt`, not `gte`: effectiveInviteStatus calls a row at exactly
      // `expiresAt` Expired, so a listing filtered by this fragment has to drop
      // it too, or a list and a read of the same row would disagree.
      expect(unexpiredInviteWhere(NOW)).toEqual({ expiresAt: { gt: NOW } });
      expect(effectiveInviteStatus({ status: InviteStatus.Pending, expiresAt: NOW }, NOW)).toBe(InviteStatus.Expired);
    });

    it('measures from the clock when no instant is given, as effectiveInviteStatus does', () => {
      jest.useFakeTimers({ now: NOW });

      try {
        expect(unexpiredInviteWhere()).toEqual({ expiresAt: { gt: NOW } });
        expect(effectiveInviteStatus({ status: InviteStatus.Pending, expiresAt: PAST })).toBe(InviteStatus.Expired);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('effectiveInviteStatusWhere', () => {
    /**
     * Evaluates the fragment against one row, for the shapes it produces: a
     * status (or a list of them), an expiry bound, an `OR`. Anything else fails
     * the test, so a new shape cannot pass by being ignored.
     */
    const matches = (where: Prisma.InviteWhereInput, row: { status: InviteStatus; expiresAt: Date }): boolean =>
      Object.entries(where).every(([key, value]) => {
        if (key === 'OR') {
          return (value as Prisma.InviteWhereInput[]).some((branch) => matches(branch, row));
        }

        if (key === 'status') {
          return typeof value === 'string'
            ? row.status === value
            : (value as { in: InviteStatus[] }).in.includes(row.status);
        }

        if (key === 'expiresAt') {
          const bound = value as { gt?: Date; lte?: Date };

          return bound.gt ? row.expiresAt > bound.gt : row.expiresAt <= (bound.lte as Date);
        }

        throw new Error(`unexpected key ${key}`);
      });

    it.each(Object.values(InviteStatus))('matches exactly the rows a read calls %s', (status) => {
      const where = effectiveInviteStatusWhere(status, NOW);

      for (const rowStatus of Object.values(InviteStatus)) {
        for (const expiresAt of [PAST, NOW, FUTURE]) {
          const row = { status: rowStatus, expiresAt };

          expect([rowStatus, expiresAt, matches(where, row)]).toEqual([
            rowStatus,
            expiresAt,
            effectiveInviteStatus(row, NOW) === status,
          ]);
        }
      }
    });
  });
});
