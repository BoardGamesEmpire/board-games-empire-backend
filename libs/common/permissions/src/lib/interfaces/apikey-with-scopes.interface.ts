import type { Apikey, ApiKeyScope, Permission } from '@bge/database';

export interface ApikeyWithScopes extends Apikey {
  scopes: ApiKeyScopeWithPermission[];
}

export interface ApiKeyScopeWithPermission extends ApiKeyScope {
  // `fields` is optional: a graph cached before the loader selected it has none.
  permission: Pick<Permission, 'action' | 'subject' | 'inverted'> & Partial<Pick<Permission, 'fields'>>;
}
