import type { Permission } from '@bge/database';
import { Action } from '@bge/database';
import { sequence } from './sequence.js';

export function makePermission(overrides: Partial<Permission> = {}): Permission {
  const n = sequence();
  return {
    id: `perm-${n}`,
    action: Action.read,
    subject: 'Game',
    fields: [],
    conditions: null,
    inverted: false,
    reason: null,
    slug: `read:game:${n}`,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
