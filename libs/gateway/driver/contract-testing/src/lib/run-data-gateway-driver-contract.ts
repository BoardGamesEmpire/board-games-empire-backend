import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { OPERATIONS } from './operations.js';

export interface DataGatewayDriverContractContext {
  driver: DataGatewayDriver;

  /**
   * The operations the driver serves. Its `describe` must declare exactly
   * these, and only their cases run.
   */
  capabilities: proto.Capability[];

  /**
   * The coverage axes its search narrows by. Its `describe` must declare
   * exactly these, and a search is filtered on each.
   */
  filterableAxes: proto.CoverageAxis[];

  /** An externalId the driver can resolve via fetchGame. */
  knownExternalId: string;

  /** An externalId the driver is guaranteed NOT to resolve. */
  unknownExternalId: string;

  /** A query expected to stream at least one RESULT frame. */
  searchQuery: string;
}

/**
 * A filter naming one value on `axis`: the first its coverage lists there,
 * or, when it lists none, tabletop or a base game. Undefined for an axis the
 * contract doesn't know.
 */
const filterOn = (axis: proto.CoverageAxis, coverage: proto.Coverage | undefined): proto.SearchFilter | undefined => {
  switch (axis) {
    case proto.CoverageAxis.COVERAGE_AXIS_PLATFORM_TYPE:
      return {
        platformTypes: [coverage?.platformTypes[0] ?? proto.PlatformType.PLATFORM_TYPE_TABLETOP],
        contentTypes: [],
      };
    case proto.CoverageAxis.COVERAGE_AXIS_CONTENT_TYPE:
      return {
        platformTypes: [],
        contentTypes: [coverage?.contentTypes[0] ?? proto.ContentType.CONTENT_TYPE_BASE_GAME],
      };
    default:
      return undefined;
  }
};

/** Every form a DataGateway's free text can take. */
const CONTENT_FORMATS: readonly proto.ContentFormat[] = [
  proto.ContentFormat.CONTENT_FORMAT_PLAIN_TEXT,
  proto.ContentFormat.CONTENT_FORMAT_HTML,
  proto.ContentFormat.CONTENT_FORMAT_BBCODE,
  proto.ContentFormat.CONTENT_FORMAT_MARKDOWN,
];

type Setup = () => DataGatewayDriverContractContext | Promise<DataGatewayDriverContractContext>;
type Teardown = (ctx: DataGatewayDriverContractContext) => void | Promise<void>;

/**
 * Shared behavioral contract every `DataGatewayDriver` implementation must
 * satisfy — run it against in-process plugins, the remote gRPC adapter (with
 * a stubbed transport), and the in-memory reference alike. Mirrors the
 * storage driver contract-testing pattern.
 *
 * A DataGateway may declare any subset of the operations, so each run names
 * the ones its driver serves, and only their cases run. A case checks that
 * `describe` declares exactly those, so a driver that stops declaring one
 * fails, rather than passing that operation's cases without running them.
 *
 * Usage:
 * ```ts
 * runDataGatewayDriverContract('InMemoryGatewayDriver', () => ({
 *   driver: new InMemoryGatewayDriver({ games: [game], capabilities: [proto.Capability.CAPABILITY_FETCH] }),
 *   capabilities: [proto.Capability.CAPABILITY_FETCH],
 *   filterableAxes: [],
 *   knownExternalId: game.externalId,
 *   unknownExternalId: 'nope',
 *   searchQuery: 'catan',
 * }));
 * ```
 */
export function runDataGatewayDriverContract(description: string, setup: Setup, teardown?: Teardown): void {
  describe(`DataGatewayDriver contract: ${description}`, () => {
    let ctx: DataGatewayDriverContractContext;

    beforeEach(async () => {
      ctx = await setup();
    });

    afterEach(async () => {
      await teardown?.(ctx);
    });

    /**
     * A case for one operation, which runs only when the run names it. Jest
     * can't skip a test once it has started, so for any other operation the
     * case passes without calling it.
     */
    const itWhenDeclared = (operation: proto.Capability, name: string, test: () => Promise<void>): void => {
      it(name, async () => {
        if (ctx.capabilities.includes(operation)) {
          await test();
        }
      });
    };

    it('ping emits a single response and completes', async () => {
      const response = await lastValueFrom(ctx.driver.ping({ correlationId: 'contract-ping' }));

      expect(response).toBeDefined();
    });

    it('check reports SERVING', async () => {
      const response = await firstValueFrom(ctx.driver.check({ service: '' }));

      expect(response.status).toBe(proto.HealthCheckResponse_ServingStatus.SERVING);
    });

    it('describe answers once, declaring only operations this contract defines', async () => {
      const responses = await lastValueFrom(
        ctx.driver.describe({ correlationId: 'contract-describe' }).pipe(toArray()),
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].capabilities.filter((capability) => !OPERATIONS.includes(capability))).toEqual([]);
    });

    it('describe declares exactly the operations the run names', async () => {
      const response = await firstValueFrom(ctx.driver.describe({ correlationId: 'contract-capabilities' }));

      expect(new Set(response.capabilities)).toEqual(new Set(ctx.capabilities));
    });

    it('describe declares exactly the filterable axes the run names', async () => {
      const response = await firstValueFrom(ctx.driver.describe({ correlationId: 'contract-filterable-axes' }));

      expect(new Set(response.filterableAxes)).toEqual(new Set(ctx.filterableAxes));
    });

    it('describe declares its content format as plain text, HTML, BBCode or Markdown', async () => {
      const response = await firstValueFrom(ctx.driver.describe({ correlationId: 'contract-content-format' }));

      expect(CONTENT_FORMATS).toContain(response.contentFormat);
    });

    describe('when it declares search', () => {
      itWhenDeclared(
        proto.Capability.CAPABILITY_SEARCH,
        'searchGames streams at least one RESULT frame and terminates with SOURCE_DONE',
        async () => {
          const frames = await lastValueFrom(
            ctx.driver.searchGames({ correlationId: 'contract-search', query: ctx.searchQuery }).pipe(toArray()),
          );

          expect(frames.length).toBeGreaterThanOrEqual(2);
          expect(frames.some((frame) => frame.status === proto.ResultStatus.RESULT_STATUS_RESULT && frame.game)).toBe(
            true,
          );
          expect(frames[frames.length - 1]?.status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
        },
      );

      // Narrowing isn't checked: a DataGateway may return games the filter
      // excludes, since the server removes them. A filter on one of its axes
      // must still end the search cleanly.
      itWhenDeclared(
        proto.Capability.CAPABILITY_SEARCH,
        'searchGames filtered on each declared axis terminates with SOURCE_DONE',
        async () => {
          const { coverage } = await firstValueFrom(ctx.driver.describe({ correlationId: 'contract-coverage' }));

          for (const axis of ctx.filterableAxes) {
            // An axis the contract doesn't know fails here, rather than passing untried.
            const filter = filterOn(axis, coverage);
            expect(filter).toBeDefined();

            const frames = await lastValueFrom(
              ctx.driver
                .searchGames({ correlationId: `contract-search-${axis}`, query: ctx.searchQuery, filter })
                .pipe(toArray()),
            );

            expect(frames[frames.length - 1]?.status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
          }
        },
      );
    });

    describe('when it declares fetch', () => {
      itWhenDeclared(
        proto.Capability.CAPABILITY_FETCH,
        'fetchGame resolves a known externalId with game data',
        async () => {
          const response = await firstValueFrom(
            ctx.driver.fetchGame({ correlationId: 'contract-fetch', externalId: ctx.knownExternalId }),
          );

          expect(response.game?.externalId).toBe(ctx.knownExternalId);
        },
      );

      itWhenDeclared(
        proto.Capability.CAPABILITY_FETCH,
        'fetchGame answers a clean not-found as a response, never an errored stream',
        async () => {
          // Consumers exempt healthy not-found interactions from auto-disable
          // tracking; a driver that throws here would let a handful of bad ids
          // disable a perfectly healthy DataGateway.
          const response = await firstValueFrom(
            ctx.driver.fetchGame({ correlationId: 'contract-miss', externalId: ctx.unknownExternalId }),
          );

          expect(response.game).toBeUndefined();
        },
      );
    });

    describe('when it declares fetch expansions', () => {
      itWhenDeclared(
        proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
        'fetchExpansions returns a terminating stream',
        async () => {
          const frames = await lastValueFrom(
            ctx.driver
              .fetchExpansions({ correlationId: 'contract-expansions', baseExternalId: ctx.knownExternalId })
              .pipe(toArray()),
          );

          expect(Array.isArray(frames)).toBe(true);
        },
      );
    });

    describe('when it declares list languages', () => {
      itWhenDeclared(
        proto.Capability.CAPABILITY_LIST_LANGUAGES,
        'listLanguages resolves with an entry array',
        async () => {
          const response = await firstValueFrom(ctx.driver.listLanguages({ correlationId: 'contract-langs' }));

          expect(Array.isArray(response.languages)).toBe(true);
        },
      );
    });

    describe('when it declares list platforms', () => {
      itWhenDeclared(
        proto.Capability.CAPABILITY_LIST_PLATFORMS,
        'listPlatforms resolves with a platform array',
        async () => {
          const response = await firstValueFrom(ctx.driver.listPlatforms({ correlationId: 'contract-platforms' }));

          expect(Array.isArray(response.platforms)).toBe(true);
        },
      );
    });

    describe('when it declares list categories', () => {
      itWhenDeclared(
        proto.Capability.CAPABILITY_LIST_CATEGORIES,
        'listCategories resolves with a category array',
        async () => {
          const response = await firstValueFrom(ctx.driver.listCategories({ correlationId: 'contract-categories' }));

          expect(Array.isArray(response.categories)).toBe(true);
        },
      );
    });

    describe('when it declares list mechanics', () => {
      itWhenDeclared(
        proto.Capability.CAPABILITY_LIST_MECHANICS,
        'listMechanics resolves with a mechanic array',
        async () => {
          const response = await firstValueFrom(ctx.driver.listMechanics({ correlationId: 'contract-mechanics' }));

          expect(Array.isArray(response.mechanics)).toBe(true);
        },
      );
    });

    it('dispose is safe to call twice', async () => {
      await ctx.driver.dispose();

      await expect(Promise.resolve(ctx.driver.dispose())).resolves.not.toThrow();
    });
  });
}
