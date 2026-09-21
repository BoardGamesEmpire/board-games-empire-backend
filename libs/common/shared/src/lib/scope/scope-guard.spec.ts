import { ClsServiceManager } from 'nestjs-cls';
import { paginated } from '../dto/paginated-response.dto.js';
import { assertListScopeComposed } from './assert-list-scope-composed.js';
import { recordComposedScope, wasScopeComposed } from './composed-scope-registry.js';
import { Unscoped } from './list-scope.js';
import { PENDING_SCOPE_SWEEP } from './pending-scope-sweep.js';
import { ListScopeNotComposedError } from './unscoped-list.error.js';

/** Runs `fn` inside a fresh CLS scope, as a request would. */
const inRequest = <T>(fn: () => T): T => ClsServiceManager.getClsService().runWith({}, fn);

const paging = { page: 1, pageSize: 25 };
const rows = { rows: [{ id: 'a' }], total: 1 };

describe('the composed-scope registry', () => {
  it('reports a resource as composed only inside the request that composed it', () => {
    inRequest(() => {
      recordComposedScope('Household');
      expect(wasScopeComposed('Household')).toBe(true);
    });

    inRequest(() => {
      expect(wasScopeComposed('Household')).toBe(false);
    });
  });

  it('keeps resources apart, so scoping one list does not vouch for another', () => {
    inRequest(() => {
      recordComposedScope('Household');

      expect(wasScopeComposed('Household')).toBe(true);
      expect(wasScopeComposed('Friendship')).toBe(false);
    });
  });

  it('records several resources in one request', () => {
    inRequest(() => {
      recordComposedScope('Household');
      recordComposedScope('Friendship');

      expect(wasScopeComposed('Household')).toBe(true);
      expect(wasScopeComposed('Friendship')).toBe(true);
    });
  });

  it('answers true outside a request, where there is no ability context to guard', () => {
    expect(wasScopeComposed('Household')).toBe(true);
  });
});

describe('assertListScopeComposed', () => {
  // Chosen so the test does not silently become vacuous as 418 empties the
  // pin: if this resource is ever added to PENDING_SCOPE_SWEEP the guard would
  // stop firing and these assertions would pass for the wrong reason.
  const UNPINNED = 'Quota';

  beforeAll(() => {
    expect(PENDING_SCOPE_SWEEP.has(UNPINNED)).toBe(false);
  });

  it('throws when a declared scope was never composed', () => {
    inRequest(() => {
      expect(() => assertListScopeComposed('quotas', UNPINNED)).toThrow(ListScopeNotComposedError);
    });
  });

  it('passes once the scope has been composed', () => {
    inRequest(() => {
      recordComposedScope(UNPINNED);

      expect(() => assertListScopeComposed('quotas', UNPINNED)).not.toThrow();
    });
  });

  it('passes an explicit opt-out without requiring a composed scope', () => {
    inRequest(() => {
      expect(() => assertListScopeComposed('languages', Unscoped('static i18n catalogue'))).not.toThrow();
    });
  });

  it('passes a resource still pinned as unswept', () => {
    inRequest(() => {
      expect(() => assertListScopeComposed('households', 'Household')).not.toThrow();
    });
  });

  it('names the resource and the envelope key, so the fix is obvious from the log', () => {
    inRequest(() => {
      expect(() => assertListScopeComposed('quotas', UNPINNED)).toThrow(/quotas/);
      expect(() => assertListScopeComposed('quotas', UNPINNED)).toThrow(new RegExp(UNPINNED));
    });
  });

  it('surfaces as a 500, not a 403 — it is a programmer error, not a denial', () => {
    inRequest(() => {
      try {
        assertListScopeComposed('quotas', UNPINNED);
        throw new Error('expected assertListScopeComposed to throw');
      } catch (error) {
        expect((error as ListScopeNotComposedError).getStatus()).toBe(500);
      }
    });
  });
});

describe('paginated() enforces the guard', () => {
  it('refuses to build an envelope for an unscoped, unpinned read', () => {
    inRequest(() => {
      expect(() => paginated('quotas', rows, paging, 'Quota')).toThrow(ListScopeNotComposedError);
    });
  });

  it('builds the envelope once the read composed its scope', () => {
    inRequest(() => {
      recordComposedScope('Quota');

      expect(paginated('quotas', rows, paging, 'Quota')).toEqual({
        quotas: [{ id: 'a' }],
        pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false },
      });
    });
  });

  it('cannot be satisfied for two lists by scoping only one of them', () => {
    // Both resources must be unpinned, or the pin rather than the registry is
    // what lets the first call through and the test proves nothing.
    expect(PENDING_SCOPE_SWEEP.has('Quota')).toBe(false);
    expect(PENDING_SCOPE_SWEEP.has('WebhookSubscription')).toBe(false);

    inRequest(() => {
      recordComposedScope('Quota');

      expect(() => paginated('quotas', rows, paging, 'Quota')).not.toThrow();
      expect(() => paginated('webhookSubscriptions', rows, paging, 'WebhookSubscription')).toThrow(
        ListScopeNotComposedError,
      );
    });
  });
});
