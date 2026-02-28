import type { Apikey, ApiKeyScope, Permission } from '@bge/database';

export interface ApikeyWithScopes extends Apikey {
  scopes: ApiKeyScopeWithPermission[];
}

export interface ApiKeyScopeWithPermission extends ApiKeyScope {
  permission: Pick<Permission, 'action' | 'subject' | 'inverted'>;
}
