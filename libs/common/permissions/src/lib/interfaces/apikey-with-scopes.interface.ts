import type { Apikey, ApiKeyScope, Permission } from '@bge/database';

export interface ApikeyWithScopes extends Apikey {
  scopes: ApiKeyScopeWithPermission[];
}

export interface ApiKeyScopeWithPermission extends ApiKeyScope {
  // A key scope keeps its permission's conditions, rendered in each context
  // where the key's owner holds the permission (#266).
  permission: Pick<Permission, 'id' | 'action' | 'subject' | 'inverted' | 'conditions' | 'fields'>;
}
