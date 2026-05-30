import { DatabaseService } from '@bge/database';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { CanActivate, ModuleMetadata, Type } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as jest from 'jest-mock';
import { ClsService } from 'nestjs-cls';
import type { MockDatabaseService } from './mock-database.service.js';
import { createMockDatabaseService } from './mock-database.service.js';

// ---------------------------------------------------------------------------
// PassThroughGuard — canActivate always returns true.
// Use this to bypass AuthGuard, PoliciesGuard, etc. in unit
// tests so their dependency chains are never resolved.
// ---------------------------------------------------------------------------
export class PassThroughGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Standard mock factories for common cross-cutting providers.
// Exposed so individual tests can import and spy on them directly.
// ---------------------------------------------------------------------------
export function createMockClsService(): jest.Mocked<ClsService> {
  return {
    get: jest.fn(),
    set: jest.fn(),
    has: jest.fn(),
    getId: jest.fn(),
    run: jest.fn(),
    runWith: jest.fn(),
    enter: jest.fn(),
    exit: jest.fn(),
  } as unknown as jest.Mocked<ClsService>;
}

export function createMockCacheManager() {
  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    reset: jest.fn(),
    wrap: jest.fn(),
    store: {},
  };
}

export interface TestingModuleWithDb {
  module: TestingModule;
  db: MockDatabaseService;
  cls: jest.Mocked<ClsService>;
}

/**
 * DI token accepted by `overrideProvider(...)`. Mirrors NestJS's
 * `InjectionToken` shape: a class constructor, string token, or symbol.
 */
export type ProviderToken = Type<unknown> | string | symbol;

/**
 * One provider-override entry. Forwarded to
 * `builder.overrideProvider(provide).useValue(useValue)`.
 *
 * Use for providers that come from an imported module and aren't trivially
 * replaceable by re-listing them in `providers` — most commonly request- or
 * transient-scoped providers (e.g. `HttpHealthIndicator` from Terminus),
 * which `module.get()` rejects.
 */
export interface ProviderOverride {
  provide: ProviderToken;
  useValue: unknown;
}

export interface CreateTestingModuleOptions extends ModuleMetadata {
  /**
   * Guards to override with PassThroughGuard.
   * Pass every guard class applied to the controller under test.
   *
   * @example
   *   overrideGuards: [AuthGuard, PoliciesGuard]
   */
  overrideGuards?: Type<CanActivate>[];

  /**
   * Provider overrides applied via `builder.overrideProvider(...).useValue(...)`.
   *
   * Necessary for providers that:
   *   - come from an imported module and can't be shadowed by re-listing
   *   - are request- or transient-scoped (`module.get()` rejects these;
   *     `module.resolve()` returns a fresh instance per call, not the one
   *     injected into the controller under test)
   *
   * @example
   *   overrideProviders: [
   *     { provide: HttpHealthIndicator, useValue: { pingCheck: jest.fn() } },
   *   ]
   */
  overrideProviders?: ProviderOverride[];
}

/**
 * Creates a NestJS TestingModule pre-wired with mocks for the three
 * providers that appear in almost every controller:
 *   - DatabaseService   → createMockDatabaseService()
 *   - ClsService        → createMockClsService()
 *   - CACHE_MANAGER     → createMockCacheManager()
 *
 * Guards are optionally overridden with PassThroughGuard via `overrideGuards`.
 * Module-imported providers (e.g. scoped Terminus indicators) can be
 * replaced via `overrideProviders`.
 *
 * Usage:
 *   const { module, db, cls } = await createTestingModuleWithDb({
 *     controllers: [GameController],
 *     providers: [GameService],
 *     overrideGuards: [AuthGuard, PoliciesGuard],
 *   });
 */
export async function createTestingModuleWithDb(options: CreateTestingModuleOptions): Promise<TestingModuleWithDb> {
  const { overrideGuards = [], overrideProviders = [], ...metadata } = options;

  const cache = createMockCacheManager();
  const db = createMockDatabaseService();
  const cls = createMockClsService();

  const builder = Test.createTestingModule({
    ...metadata,
    providers: [
      ...(metadata.providers ?? []),
      { provide: DatabaseService, useValue: db },
      { provide: ClsService, useValue: cls },
      { provide: CACHE_MANAGER, useValue: cache },
    ],
  });

  for (const guard of overrideGuards) {
    builder.overrideGuard(guard).useClass(PassThroughGuard);
  }

  for (const { provide, useValue } of overrideProviders) {
    builder.overrideProvider(provide).useValue(useValue);
  }

  const module = await builder.compile();
  return { module, db, cls };
}
