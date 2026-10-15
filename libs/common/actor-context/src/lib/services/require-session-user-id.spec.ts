import { t } from '@bge/i18n-core';
import { ForbiddenException } from '@nestjs/common';
import { SERVER_PLUGIN_UNIT, type Actor } from '../types';
import { requireSessionUserId } from './require-session-user-id';

function refusalOf(actor: Actor | null): unknown {
  try {
    requireSessionUserId(actor);
  } catch (caught) {
    return caught;
  }

  throw new Error('requireSessionUserId answered instead of refusing');
}

describe('requireSessionUserId', () => {
  it("answers a session user's id", () => {
    expect(requireSessionUserId({ kind: 'user', userId: 'user-1' })).toBe('user-1');
  });

  // Every refused kind but the last carries a user, so none can pass by
  // answering with whoever stands behind it.
  it.each<[string, Actor | null]>([
    ['apiKey', { kind: 'apiKey', apiKeyId: 'key-1', userId: 'user-1' }],
    ['anonymous', { kind: 'anonymous', userId: 'user-1' }],
    [
      'plugin',
      {
        kind: 'plugin',
        pluginId: 'plugin-foo',
        unit: SERVER_PLUGIN_UNIT,
        trigger: { kind: 'user', userId: 'user-1' },
      },
    ],
    ['system', { kind: 'system', reason: 'migration' }],
    ['missing', null],
  ])('refuses a %s actor with a 403', (_kind, actor) => {
    const error = refusalOf(actor);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual(t('common.forbidden.action'));
  });
});
