import type { Invite } from '@bge/database';
import { InviteStatus, InviteType } from '@bge/database';
import { sequence } from './sequence.js';

/**
 * A complete `Invite` row. Every column is present, so the return type is the
 * model itself rather than a cast past the columns the fixture used to omit:
 * a column added to the model fails here until the fixture names it.
 */
export function makeInvite(inviterId: string, overrides: Partial<Invite> = {}): Invite {
  const n = sequence();
  return {
    id: `invite-${n}`,
    status: InviteStatus.Pending,
    type: InviteType.Household,
    inviterId,
    inviteeId: null,
    inviteeEmail: null,
    inviteeName: null,
    eventId: null,
    householdId: null,
    roleId: null,
    message: null,
    metadata: null,
    token: `invite-token-${n}`,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 48),
    needsApproval: false,
    approvedById: null,
    approvedAt: null,
    respondedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
