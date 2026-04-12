import type { Role, UserRole } from '@bge/database';
import { sequence } from './sequence.js';

export function makeRole(overrides: Partial<Role> = {}): Role {
  const n = sequence();
  return {
    id: `role-${n}`,
    name: `Role_${n}`,
    description: null,
    isSystem: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeUserRole(userId: string, roleId: string, overrides: Partial<UserRole> = {}): UserRole {
  return {
    id: `ur-${sequence()}`,
    userId,
    roleId,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
