import { resolve } from 'node:path';

/** The roles one BGE image runs, each mapped to the app under `apps/` that serves it (#200, #593). */
export const ROLE_APPS = {
  api: 'api',
  worker: 'worker',
  'gateway-fetch': 'gateway-worker',
  coordinator: 'gateway-coordinator',
} as const;

export type Role = keyof typeof ROLE_APPS;

const ACCEPTED = `Accepted roles: ${Object.keys(ROLE_APPS).join(', ')}.`;

/** `BGE_ROLES` cannot be satisfied; the message is the whole explanation, for the boot log. */
export class RoleSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleSelectionError';
  }
}

/**
 * Reads `BGE_ROLES`, a comma-separated list that may name exactly one role for
 * now. Several roles in one process is the all-in-one profile (#200), which
 * widens this parser rather than replacing it.
 */
export function parseRoles(value: string | undefined): Role[] {
  if (value === undefined) {
    throw new RoleSelectionError(`BGE_ROLES is not set. Set it to the role this process runs. ${ACCEPTED}`);
  }
  if (value.trim() === '') {
    throw new RoleSelectionError(`BGE_ROLES is empty. Set it to the role this process runs. ${ACCEPTED}`);
  }
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.includes('')) {
    throw new RoleSelectionError(`BGE_ROLES has an empty entry, "${value}". ${ACCEPTED}`);
  }
  const roles: Role[] = [];
  for (const entry of entries) {
    if (!isRole(entry)) {
      throw new RoleSelectionError(`BGE_ROLES names an unknown role, "${entry}". ${ACCEPTED}`);
    }
    roles.push(entry);
  }
  if (roles.length > 1) {
    throw new RoleSelectionError(
      `BGE_ROLES names ${roles.length} roles, "${value}", but a process runs one role. Start one process per role. ${ACCEPTED}`,
    );
  }
  return roles;
}

function isRole(value: string): value is Role {
  return Object.hasOwn(ROLE_APPS, value);
}

/**
 * The role's bundle, found from the launcher's own directory: the image keeps
 * the workspace's layout, so `apps/launcher/dist` sits beside `apps/<app>/dist`.
 */
export function roleBundlePath(role: Role, launcherDir: string): string {
  return resolve(launcherDir, '..', '..', ROLE_APPS[role], 'dist', 'main.js');
}
