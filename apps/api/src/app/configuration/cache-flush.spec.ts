import { PermissionsService } from '@bge/permissions';
import Keyv from 'keyv';
import { bootstrapCacheFlushPatterns } from './cache-flush';
import { API_CACHE_NAMESPACE } from './cache.config';

// The boot flush SCANs physical keys; the CacheModule writes them through Keyv
// under API_CACHE_NAMESPACE. Writing through Keyv here pins the joint: a change
// to the namespace, to Keyv's separator, or to a PermissionsService key format
// either keeps the two aligned or fails this spec.

const globToRegExp = (glob: string) =>
  new RegExp(
    `^${glob
      .split('*')
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );

describe('bootstrapCacheFlushPatterns', () => {
  it('names the physical keys Keyv writes under the api cache namespace, for both permission graphs and nothing else', async () => {
    const store = new Map<string, string>();
    const keyv = new Keyv({ store, namespace: API_CACHE_NAMESPACE });
    const patterns = bootstrapCacheFlushPatterns().map(globToRegExp);
    const matched = (key: string) => patterns.some((pattern) => pattern.test(key));

    await keyv.set(PermissionsService.userGraphCacheKey('user-1'), {});
    await keyv.set(PermissionsService.apiKeyScopeCacheKey('key-1'), {});
    const graphs = [...store.keys()];
    await keyv.set('bge:session:other', {});
    const bystander = [...store.keys()].find((key) => !graphs.includes(key));

    expect(graphs).toHaveLength(2);
    expect(graphs.every(matched)).toBe(true);
    expect(bystander).toBeDefined();
    expect(matched(bystander as string)).toBe(false);
  });
});
