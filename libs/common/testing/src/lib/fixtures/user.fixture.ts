import type { User } from '@bge/database';
import { sequence } from './sequence.js';

export function makeUser(overrides: Partial<User> = {}): User {
  const n = sequence();
  return {
    id: `user-${n}`,
    username: `user_${n}`,
    email: `user${n}@example.com`,
    emailVerified: true,
    banned: false,
    banExpires: null,
    banReason: null,
    isAnonymous: false,
    image: null,
    firstName: 'Test',
    lastName: 'User',
    twoFactorEnabled: false,
    role: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
