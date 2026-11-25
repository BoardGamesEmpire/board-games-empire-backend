import { InviteType } from '@bge/database';
import { CONTEXTUAL_INVITE_TYPES, isContextualInviteType } from './invite.constants';

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
