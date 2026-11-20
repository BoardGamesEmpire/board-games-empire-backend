import { t } from '@bge/i18n-core';
import { ForbiddenException } from '@nestjs/common';
import type { Actor } from '../types';
import { SERVER_PLUGIN_UNIT } from '../types';
import { requireSessionUserId, sessionUserId } from './require-session-user-id';

function refusalOf(actor: Actor | null): unknown {
  try {
    requireSessionUserId(actor);
  } catch (caught) {
    return caught;
  }

  throw new Error('requireSessionUserId answered instead of refusing');
}

/**
 * Every actor that is not a person signed in as themself. Each but the last
 * carries a user, so none can pass by answering with whoever stands behind it.
 */
const NOT_A_SESSION_USER: [string, Actor | null][] = [
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
];

describe('requireSessionUserId', () => {
  it("answers a session user's id", () => {
    expect(requireSessionUserId({ kind: 'user', userId: 'user-1' })).toBe('user-1');
  });

  it.each(NOT_A_SESSION_USER)('refuses a %s actor with a 403', (_kind, actor) => {
    const error = refusalOf(actor);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual(t('common.forbidden.action'));
  });
});

// For a route that settles a request either way, such as the Steam sign-in's
// return, which sends the browser back with a code rather than a 403 (#935).
describe('sessionUserId', () => {
  it("answers a session user's id", () => {
    expect(sessionUserId({ kind: 'user', userId: 'user-1' })).toBe('user-1');
  });

  it.each(NOT_A_SESSION_USER)('answers null for a %s actor', (_kind, actor) => {
    expect(sessionUserId(actor)).toBeNull();
  });
});
