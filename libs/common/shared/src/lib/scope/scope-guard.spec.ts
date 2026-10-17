import { ClsServiceManager } from 'nestjs-cls';
import { paginated } from '../dto/paginated-response.dto.js';
import { assertListScopeComposed } from './assert-list-scope-composed.js';
import { recordComposedScope, wasScopeComposed } from './composed-scope-registry.js';
import { Unscoped } from './list-scope.js';
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
  const RESOURCE = 'Quota';

  it('throws when a declared scope was never composed', () => {
    inRequest(() => {
      expect(() => assertListScopeComposed('quotas', RESOURCE)).toThrow(ListScopeNotComposedError);
    });
  });

  it('passes once the scope has been composed', () => {
    inRequest(() => {
      recordComposedScope(RESOURCE);

      expect(() => assertListScopeComposed('quotas', RESOURCE)).not.toThrow();
    });
  });

  it('passes an explicit opt-out without requiring a composed scope', () => {
    inRequest(() => {
      expect(() => assertListScopeComposed('languages', Unscoped('static i18n catalogue'))).not.toThrow();
    });
  });

  it('refuses a hand-built opt-out carrying no reason', () => {
    // `UnscopedList` is structural, so this literal typechecks without ever
    // reaching `Unscoped()` and its reason check. If the guard took it at its
    // word, "unscoped" would be assertable while stating nothing — and the
    // stated reason is the entire value of the opt-out.
    inRequest(() => {
      expect(() => assertListScopeComposed('languages', { kind: 'unscoped', reason: '  ' })).toThrow(TypeError);
    });
  });

  it('names the resource and the envelope key, so the fix is obvious from the log', () => {
    inRequest(() => {
      expect(() => assertListScopeComposed('quotas', RESOURCE)).toThrow(/quotas/);
      expect(() => assertListScopeComposed('quotas', RESOURCE)).toThrow(new RegExp(RESOURCE));
    });
  });

  it('surfaces as a 500, not a 403 — it is a programmer error, not a denial', () => {
    inRequest(() => {
      try {
        assertListScopeComposed('quotas', RESOURCE);
        throw new Error('expected assertListScopeComposed to throw');
      } catch (error) {
        expect((error as ListScopeNotComposedError).getStatus()).toBe(500);
      }
    });
  });
});

describe('paginated() enforces the guard', () => {
  it('refuses to build an envelope for a read whose scope was never composed', () => {
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
    inRequest(() => {
      recordComposedScope('Quota');

      expect(() => paginated('quotas', rows, paging, 'Quota')).not.toThrow();
      expect(() => paginated('webhookSubscriptions', rows, paging, 'WebhookSubscription')).toThrow(
        ListScopeNotComposedError,
      );
    });
  });
});
