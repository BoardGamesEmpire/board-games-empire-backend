import type { GrantablePermission } from '@bge/permissions';
import { grantablePermissions, PermissionsService } from '@bge/permissions';
import { Injectable } from '@nestjs/common';

/** A user's API keys: what a new key may hold (#1417), and the create route #1418 adds. */
@Injectable()
export class ApiKeyService {
  constructor(private readonly permissions: PermissionsService) {}

  /**
   * The permissions `userId`'s API key may hold, sorted by slug (#1417). The
   * graph is the one every request's ability is built from, so the list shows
   * what the owner holds now. A user with no graph, such as one deleted a
   * moment ago, gets an empty list.
   */
  async grantableFor(userId: string): Promise<GrantablePermission[]> {
    const graph = await this.permissions.getUserRoleGraph(userId);

    return graph ? grantablePermissions(graph) : [];
  }
}
