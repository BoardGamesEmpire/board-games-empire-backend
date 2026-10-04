import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseRoles, ROLE_APPS, roleBundlePath, RoleSelectionError } from './roles';

const ACCEPTED = 'Accepted roles: api, worker, gateway-fetch, coordinator.';

describe('parseRoles', () => {
  it('accepts one known role', () => {
    expect(parseRoles('gateway-fetch')).toEqual(['gateway-fetch']);
  });

  it.each([
    [undefined, `BGE_ROLES is not set. Set it to the role this process runs. ${ACCEPTED}`],
    ['', `BGE_ROLES is empty. Set it to the role this process runs. ${ACCEPTED}`],
    ['  ', `BGE_ROLES is empty. Set it to the role this process runs. ${ACCEPTED}`],
  ])('refuses %p, naming the roles it accepts', (value, message) => {
    expect(() => parseRoles(value)).toThrow(new RoleSelectionError(message));
  });

  it.each(['web', 'API', 'gateway-worker'])('refuses the unknown role %p by name', (value) => {
    expect(() => parseRoles(value)).toThrow(
      new RoleSelectionError(`BGE_ROLES names an unknown role, "${value}". ${ACCEPTED}`),
    );
  });

  it.each([
    ['api,worker', 2],
    ['api, worker, coordinator', 3],
  ])('refuses %p: a process runs one role', (value, count) => {
    expect(() => parseRoles(value)).toThrow(
      new RoleSelectionError(
        `BGE_ROLES names ${count} roles, "${value}", but a process runs one role. Start one process per role. ${ACCEPTED}`,
      ),
    );
  });

  it('ignores whitespace around the role', () => {
    expect(parseRoles(' api ')).toEqual(['api']);
  });

  it.each(['api,', ',api', 'api,,worker'])('refuses %p, which has an empty entry', (value) => {
    expect(() => parseRoles(value)).toThrow(
      new RoleSelectionError(`BGE_ROLES has an empty entry, "${value}". ${ACCEPTED}`),
    );
  });

  it('names an unknown role in a list before counting the list', () => {
    expect(() => parseRoles('api,web')).toThrow(
      new RoleSelectionError(`BGE_ROLES names an unknown role, "web". ${ACCEPTED}`),
    );
  });
});

describe('roleBundlePath', () => {
  it.each([
    ['api', '/app/apps/api/dist/main.js'],
    ['worker', '/app/apps/worker/dist/main.js'],
    ['gateway-fetch', '/app/apps/gateway-worker/dist/main.js'],
    ['coordinator', '/app/apps/gateway-coordinator/dist/main.js'],
  ] as const)('runs %s from %s, beside the launcher', (role, bundle) => {
    expect(roleBundlePath(role, '/app/apps/launcher/dist')).toBe(bundle);
  });

  it.each(Object.values(ROLE_APPS))('finds the app %s in this workspace', (app) => {
    expect(existsSync(join(__dirname, '..', '..', app, 'package.json'))).toBe(true);
  });
});
