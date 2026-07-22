import type { GameGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';

export interface GameGatewayDriverContractContext {
  driver: GameGatewayDriver;

  /** An externalId the driver can resolve via fetchGame. */
  knownExternalId: string;

  /** An externalId the driver is guaranteed NOT to resolve. */
  unknownExternalId: string;

  /** A query expected to stream at least one RESULT frame. */
  searchQuery: string;
}

type Setup = () => GameGatewayDriverContractContext | Promise<GameGatewayDriverContractContext>;
type Teardown = (ctx: GameGatewayDriverContractContext) => void | Promise<void>;

/**
 * Shared behavioral contract every `GameGatewayDriver` implementation must
 * satisfy — run it against in-process plugins, the remote gRPC adapter (with
 * a stubbed transport), and the in-memory reference alike. Mirrors the
 * storage driver contract-testing pattern.
 *
 * Usage:
 * ```ts
 * runGameGatewayDriverContract('InMemoryGatewayDriver', () => ({
 *   driver: new InMemoryGatewayDriver({ games: [game], searchResults: [data] }),
 *   knownExternalId: game.externalId,
 *   unknownExternalId: 'nope',
 *   searchQuery: 'catan',
 * }));
 * ```
 */
export function runGameGatewayDriverContract(description: string, setup: Setup, teardown?: Teardown): void {
  describe(`GameGatewayDriver contract: ${description}`, () => {
    let ctx: GameGatewayDriverContractContext;

    beforeEach(async () => {
      ctx = await setup();
    });

    afterEach(async () => {
      await teardown?.(ctx);
    });

    it('ping emits a single response and completes', async () => {
      const response = await lastValueFrom(ctx.driver.ping({ correlationId: 'contract-ping' }));

      expect(response).toBeDefined();
    });

    it('check reports SERVING', async () => {
      const response = await firstValueFrom(ctx.driver.check({ service: '' }));

      expect(response.status).toBe(proto.HealthCheckResponse_ServingStatus.SERVING);
    });

    it('searchGames streams at least one RESULT frame and terminates with SOURCE_DONE', async () => {
      const frames = await lastValueFrom(
        ctx.driver.searchGames({ correlationId: 'contract-search', query: ctx.searchQuery }).pipe(toArray()),
      );

      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(frames.some((frame) => frame.status === proto.ResultStatus.RESULT_STATUS_RESULT && frame.game)).toBe(true);
      expect(frames[frames.length - 1]?.status).toBe(proto.ResultStatus.RESULT_STATUS_SOURCE_DONE);
    });

    it('fetchGame resolves a known externalId with game data', async () => {
      const response = await firstValueFrom(
        ctx.driver.fetchGame({ correlationId: 'contract-fetch', externalId: ctx.knownExternalId }),
      );

      expect(response.game?.externalId).toBe(ctx.knownExternalId);
    });

    it('fetchGame answers a clean not-found as a response, never an errored stream', async () => {
      // Consumers exempt healthy not-found interactions from auto-disable
      // tracking; a driver that throws here would let a handful of bad ids
      // disable a perfectly healthy gateway.
      const response = await firstValueFrom(
        ctx.driver.fetchGame({ correlationId: 'contract-miss', externalId: ctx.unknownExternalId }),
      );

      expect(response.game).toBeUndefined();
    });

    it('fetchExpansions returns a terminating stream', async () => {
      const frames = await lastValueFrom(
        ctx.driver
          .fetchExpansions({ correlationId: 'contract-expansions', baseExternalId: ctx.knownExternalId })
          .pipe(toArray()),
      );

      expect(Array.isArray(frames)).toBe(true);
    });

    it('listLanguages resolves with an entry array', async () => {
      const response = await firstValueFrom(ctx.driver.listLanguages({ correlationId: 'contract-langs' }));

      expect(Array.isArray(response.languages)).toBe(true);
    });

    it('dispose is safe to call twice', async () => {
      await ctx.driver.dispose();

      await expect(Promise.resolve(ctx.driver.dispose())).resolves.not.toThrow();
    });
  });
}
