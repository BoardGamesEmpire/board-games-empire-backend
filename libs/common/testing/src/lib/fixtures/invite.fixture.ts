import type { Invite } from '@bge/database';
import { InviteStatus, InviteType } from '@bge/database';
import { sequence } from './sequence.js';

export function makeInvite(inviterId: string, overrides: Partial<Invite> = {}): Invite {
  const n = sequence();
  return {
    id: `invite-${n}`,
    inviterId,
    inviteeId: null,
    approvedById: null,
    roleId: null,
    inviteeEmail: null,
    token: `invite-token-${n}`,
    type: InviteType.Household,
    status: InviteStatus.Pending,
    householdId: null,
    eventId: null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 48),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  } as Invite;
}
