import type { Session } from '@bge/database';
import { DateTime } from 'luxon';
import { sequence } from './sequence.js';

export function makeSession(userId: string, overrides: Partial<Session> = {}): Session {
  const n = sequence();
  return {
    id: `session-${n}`,
    userId,
    token: `token-${n}`,
    expiresAt: DateTime.now().plus({ days: 1 }).toJSDate(),
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    impersonatedBy: null,
    createdAt: DateTime.now().minus({ hours: 1 }).toJSDate(),
    updatedAt: DateTime.now().toJSDate(),
    ...overrides,
  };
}
