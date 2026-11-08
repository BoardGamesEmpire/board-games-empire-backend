import { ProviderLinkingPolicy } from '@bge/database';
import type { TestDatabase } from './test-db';

/**
 * Starts each test in the calling `describe` under the `SignedIn` provider
 * linking policy, and puts back what the settings row held after (#913). The
 * row is on the isolation sweep's preserved list, so a policy left changed
 * would carry into every spec after.
 *
 * Returns the setter a test changes the policy with. `database` is called at
 * each hook rather than now, since a spec opens its database in `beforeAll`.
 */
export function useProviderLinkingPolicy(
  database: () => TestDatabase,
): (policy: ProviderLinkingPolicy) => Promise<void> {
  const set = async (policy: ProviderLinkingPolicy): Promise<void> => {
    await database().client.systemSetting.update({
      where: { singleton: true },
      data: { providerLinkingPolicy: policy },
    });
  };

  let original: ProviderLinkingPolicy;

  beforeEach(async () => {
    original = (await database().client.systemSetting.findUniqueOrThrow({ where: { singleton: true } }))
      .providerLinkingPolicy;
    await set(ProviderLinkingPolicy.SignedIn);
  });

  afterEach(async () => {
    await set(original);
  });

  return set;
}
