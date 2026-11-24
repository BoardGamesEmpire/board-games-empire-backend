import type { Permission } from '@bge/database';
import { Action, ResourceType, RiskLevel } from '@bge/database';
import type { PermissionsService, UserWithRoles } from '@bge/permissions';
import { makePermission } from '@bge/testing';
import { ApiKeyService } from './api-key.service';

describe('ApiKeyService (#1417)', () => {
  const readGame = makePermission({ id: 'perm-read-game', slug: 'read:game', subject: ResourceType.Game });
  const readOwnNotification = makePermission({
    id: 'perm-read-notification',
    slug: 'read:notification:own',
    subject: ResourceType.Notification,
    conditions: { userId: '{{ user.id }}' },
    riskLevel: RiskLevel.Medium,
  });
  const denyPrivateGames = makePermission({
    id: 'perm-deny-private-games',
    slug: 'read:game:deny_private',
    action: Action.read,
    subject: ResourceType.Game,
    inverted: true,
  });

  let permissions: jest.Mocked<Pick<PermissionsService, 'getUserRoleGraph'>>;
  let service: ApiKeyService;

  beforeEach(() => {
    permissions = { getUserRoleGraph: jest.fn() };
    service = new ApiKeyService(permissions as unknown as PermissionsService);
  });

  it("reads the signed-in user's graph and returns its grantable permissions", async () => {
    permissions.getUserRoleGraph.mockResolvedValue(
      graphOf('user-1', [readOwnNotification, readGame, denyPrivateGames]),
    );

    await expect(service.grantableFor('user-1')).resolves.toEqual([
      { id: readGame.id, slug: 'read:game', riskLevel: RiskLevel.Low, pinnable: false },
      { id: readOwnNotification.id, slug: 'read:notification:own', riskLevel: RiskLevel.Medium, pinnable: true },
    ]);
    expect(permissions.getUserRoleGraph).toHaveBeenCalledWith('user-1');
  });

  // A deleted user has no graph, so there is nothing a key could hold.
  it('a missing graph gives an empty list', async () => {
    permissions.getUserRoleGraph.mockResolvedValue(null);

    await expect(service.grantableFor('user-1')).resolves.toEqual([]);
  });
});

/** A user holding `permissions` through one server role. */
function graphOf(userId: string, permissions: Permission[]): UserWithRoles {
  return {
    id: userId,
    roles: [{ role: { name: 'User', permissions: permissions.map((permission) => ({ permission })) } }],
    householdMember: [],
    eventsAttended: [],
    permissions: [],
  };
}
