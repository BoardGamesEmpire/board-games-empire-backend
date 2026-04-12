import type { Session } from '@bge/database';
import { sequence } from './sequence.js';

export function makeSession(userId: string, overrides: Partial<Session> = {}): Session {
  const n = sequence();
  return {
    id: `session-${n}`,
    userId,
    token: `token-${n}`,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    ipAddress: '127.0.0.1',
    userAgent: 'jest',
    impersonatedBy: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
