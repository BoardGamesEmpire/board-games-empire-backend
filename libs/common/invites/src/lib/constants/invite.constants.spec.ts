import { InviteStatus, InviteType } from '@bge/database';
import {
  CONTEXTUAL_INVITE_TYPES,
  isContextualInviteType,
  LISTED_BY_DEFAULT_INVITE_STATUSES,
  OUTSTANDING_INVITE_STATUSES,
} from './invite.constants';

describe('LISTED_BY_DEFAULT_INVITE_STATUSES', () => {
  // Every invite list's default, so an inviter sees an invite lapse and can send another (#751, #742).
  it('is the outstanding statuses and Expired, nothing settled by an answer', () => {
    expect([...LISTED_BY_DEFAULT_INVITE_STATUSES]).toEqual([...OUTSTANDING_INVITE_STATUSES, InviteStatus.Expired]);
  });
});

describe('isContextualInviteType', () => {
  it.each(CONTEXTUAL_INVITE_TYPES)('admits %s, whose rows name a context a party route serves (#742)', (type) => {
    expect(isContextualInviteType(type)).toBe(true);
  });

  it.each([InviteType.System, InviteType.Campaign])('refuses %s, which no party route serves (#742)', (type) => {
    expect(isContextualInviteType(type)).toBe(false);
  });

  it('lists every invite type but System and Campaign, so a new kind has to be placed on purpose (#742)', () => {
    expect([...CONTEXTUAL_INVITE_TYPES].sort()).toEqual(
      Object.values(InviteType)
        .filter((type) => type !== InviteType.System && type !== InviteType.Campaign)
        .sort(),
    );
  });
});
