import { AuthService } from '@bge/auth';
import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, ResourceType } from '@bge/database';
import type {
  WsClientData,
  WsRateLimitedPayload,
  WsSearchErrorPayload,
  WsSearchResultPayload,
  WsSourceDonePayload,
} from '@bge/game-search';
import { GameSearchService, SearchCancelDto, SearchEvents, SearchStartDto } from '@bge/game-search';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  makeGame,
  makeGameWithSource,
  type MockAbilityService,
  MockDatabaseService,
} from '@bge/testing';
import {
  ContentType,
  GameSearchData,
  ResultStatus,
  SearchGameResult,
  SearchGamesRequest,
} from '@boardgamesempire/proto-gateway';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import * as crypto from 'node:crypto';
import type { Subscription } from 'rxjs';
import { NEVER, of, throwError } from 'rxjs';
import { Server, Socket } from 'socket.io';
import { GameSearchGateway } from './search.gateway';

// The actor the socket authenticated as at connection time (`client.data`).
const SOCKET_ID = 'socket-test-1';
const SOCKET_USER_ID = 'socket-user';
const SOCKET_ABILITY = { sentinel: 'socket-ability' };
const SOCKET_READ = { id: 'sentinel-socket-read-condition' };

describe('GameSearchGateway', () => {
  let gateway: GameSearchGateway;
  let db: MockDatabaseService;
  let coordinator: jest.Mocked<GatewayCoordinatorClientService>;
  let abilityService: MockAbilityService;
  let mockEmit: jest.Mock;
  let mockTo: jest.Mock<{ emit: jest.Mock }, [string]>;

  beforeEach(async () => {
    coordinator = {
      searchGames: jest.fn(),
      fetchGame: jest.fn(),
      fetchExpansions: jest.fn(),
      ping: jest.fn(),
      connectGateway: jest.fn(),
      disconnectGateway: jest.fn(),
    } as unknown as jest.Mocked<GatewayCoordinatorClientService>;

    abilityService = createMockAbilityService();
    abilityService.resolveAbilitiesForActor.mockResolvedValue([SOCKET_ABILITY]);
    abilityService.getResourceConditionsForAbilities.mockReturnValue([SOCKET_READ]);

    const { module, db: mockDb } = await createTestingModuleWithDb({
      overrideGuards: [AuthGuard],
      providers: [
        GameSearchGateway,
        // Real GameSearchService: the gateway delegates its local query + proto
        // mapping to it (bug #16). It shares the mock DatabaseService provided by
        // createTestingModuleWithDb, so `db.game.findMany` assertions still hold.
        GameSearchService,
        {
          provide: GatewayCoordinatorClientService,
          useValue: coordinator,
        },
        {
          provide: AuthService,
          useValue: { verifyToken: jest.fn() },
        },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = mockDb;
    gateway = module.get(GameSearchGateway);

    // Wire a mock server so gateway emissions can be asserted.
    // server.to(room) is a fluent interface; mockTo captures the room arg,
    // mockEmit captures the (event, payload) args.
    mockEmit = jest.fn();
    mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
    (gateway as unknown as { server: Server }).server = { to: mockTo } as unknown as Server;
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * Asserts that `server.to(room).emit(event, payload)` was called with the
   * expected room and event, returning the matched payload for further
   * inspection when needed.
   */
  function assertEmitted<T>(room: string, event: string, partialPayload?: Partial<T>): T {
    expect(mockTo).toHaveBeenCalledWith(room);
    const call = mockEmit.mock.calls.find(([e]) => e === event);
    expect(call).toBeDefined();
    const payload = call![1] as T;
    if (partialPayload) {
      expect(payload).toMatchObject(partialPayload);
    }

    return payload;
  }

  function countEmissionsFor(event: string): number {
    return mockEmit.mock.calls.filter(([e]) => e === event).length;
  }

  describe('handleDisconnect()', () => {
    it('unsubscribes all active searches', () => {
      const client = makeSocket(gateway);
      const sub1 = seedActiveSearch(gateway, client, 'corr-1');
      const sub2 = seedActiveSearch(gateway, client, 'corr-2');

      gateway.handleDisconnect(client);

      expect(sub1.unsubscribe).toHaveBeenCalledTimes(1);
      expect(sub2.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('clears the activeSearches map', () => {
      const client = makeSocket(gateway);
      seedActiveSearch(gateway, client, 'corr-1');
      seedActiveSearch(gateway, client, 'corr-2');

      gateway.handleDisconnect(client);

      expect(clientData(gateway, client).activeSearches.size).toBe(0);
    });

    it('does not throw when there are no active searches', () => {
      const client = makeSocket(gateway);
      expect(() => gateway.handleDisconnect(client)).not.toThrow();
    });
  });

  describe('handleSearchStart()', () => {
    describe('guard conditions', () => {
      it('emits an error when correlationId is already active', async () => {
        const client = makeSocket(gateway);
        seedActiveSearch(gateway, client, 'corr-1');
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));

        await gateway.handleSearchStart(client, makeStartDto());
        assertEmitted<WsSearchErrorPayload>(room('corr-1'), SearchEvents.SearchError, {
          correlationId: 'corr-1',
          source: 'local',
          message: `Search with correlationId corr-1 is already active`,
        });
      });

      it('joins the correlationId room before beginning the search', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));

        await gateway.handleSearchStart(client, makeStartDto());

        expect(client.join).toHaveBeenCalledWith(room('corr-1'));
      });
    });

    describe('coordinator integration', () => {
      it('forwards the correct SearchGamesRequest to the coordinator', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone('corr-2', 'igdb-gw-1')));

        await gateway.handleSearchStart(
          client,
          makeStartDto({
            correlationId: 'corr-2',
            query: 'Pandemic',
            gatewayIds: ['igdb-gw-1'],
            limit: 10,
            offset: 5,
          }),
        );

        expect(coordinator.searchGames).toHaveBeenCalledWith(
          expect.objectContaining<Partial<SearchGamesRequest>>({
            correlationId: 'corr-2',
            query: 'Pandemic',
            gatewayIds: ['igdb-gw-1'],
            limit: 10,
            offset: 5,
          }),
        );
      });
    });

    describe('local DB path', () => {
      it('does not query the DB when includeLocal is false', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));

        await gateway.handleSearchStart(client, makeStartDto({ includeLocal: false }));

        expect(db.game.findMany).not.toHaveBeenCalled();
      });

      it('queries the DB when includeLocal is true', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));
        db.game.findMany.mockResolvedValue([]);

        await gateway.handleSearchStart(client, makeStartDto({ includeLocal: true }));

        expect(db.game.findMany).toHaveBeenCalledTimes(1);
      });

      it('queries the DB when includeLocal is omitted (defaults to true)', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));
        db.game.findMany.mockResolvedValue([]);

        const dto = makeStartDto();
        delete dto.includeLocal;
        await gateway.handleSearchStart(client, dto);

        expect(db.game.findMany).toHaveBeenCalledTimes(1);
      });

      it('emits search:result for each local game with source="local"', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone('corr-1', 'local')));
        db.game.findMany.mockResolvedValue([
          makeGameWithSource(),
          makeGameWithSource({ id: 'game-2', title: 'Wingspan' }),
        ]);

        await gateway.handleSearchStart(
          client,
          makeStartDto({
            correlationId: crypto.randomUUID(),
            includeLocal: true,
            includeExternal: false,
          }),
        );

        const resultCalls = mockEmit.mock.calls.filter(
          ([event, payload]) =>
            event === SearchEvents.SearchResult && (payload as WsSearchResultPayload).source === 'local',
        );
        const gameCount = resultCalls.reduce((n, [, p]) => n + (p as WsSearchResultPayload).games.length, 0);
        expect(gameCount).toBe(2);
      });

      it('reads only what the socket’s own actor may read', async () => {
        // No ability context is primed for a WebSocket message (#498), so the
        // gateway resolves the actor the connection authenticated as, per search.
        const client = makeSocket(gateway);
        db.game.findMany.mockResolvedValue([]);

        await gateway.handleSearchStart(client, makeStartDto({ includeLocal: true, includeExternal: false }));

        expect(abilityService.resolveAbilitiesForActor).toHaveBeenCalledWith({ kind: 'user', userId: SOCKET_USER_ID });
        expect(abilityService.getResourceConditionsForAbilities).toHaveBeenCalledWith(
          [SOCKET_ABILITY],
          ResourceType.Game,
          Action.read,
        );
        expect(db.game.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ AND: [SOCKET_READ] }) }),
        );
      });

      it('queries nothing and emits a local error when the actor’s abilities cannot be resolved', async () => {
        const client = makeSocket(gateway);
        abilityService.resolveAbilitiesForActor.mockRejectedValue(new Error('role graph unavailable'));

        await gateway.handleSearchStart(client, makeStartDto({ includeLocal: true, includeExternal: false }));

        expect(db.game.findMany).not.toHaveBeenCalled();
        assertEmitted<WsSearchErrorPayload>(room('corr-1'), SearchEvents.SearchError, {
          correlationId: 'corr-1',
          source: 'local',
          message: 'Local search failed',
        });
        assertEmitted<WsSourceDonePayload>(room('corr-1'), SearchEvents.SearchSourceDone, { source: 'local' });
      });

      it('emits search:source_done with source="local" after local results', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone('corr-1', 'local')));
        db.game.findMany.mockResolvedValue([makeGame()]);

        await gateway.handleSearchStart(client, makeStartDto({ includeLocal: true, includeExternal: false }));

        assertEmitted<WsSourceDonePayload>(room('corr-1'), SearchEvents.SearchSourceDone, {
          correlationId: 'corr-1',
          source: 'local',
        });
      });
    });

    describe('coordinator stream → WS event mapping', () => {
      it('emits search:result for each RESULT_STATUS_RESULT frame', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(
          of(
            makeResultFrame({
              game: {
                externalId: '1',
                title: 'A',
                contentType: ContentType.CONTENT_TYPE_BASE_GAME,
              } as GameSearchData,
            }),
            makeResultFrame({
              game: {
                externalId: '2',
                title: 'B',
                contentType: ContentType.CONTENT_TYPE_BASE_GAME,
              } as GameSearchData,
            }),
            makeSourceDone(),
          ),
        );

        await gateway.handleSearchStart(client, makeStartDto());

        expect(countEmissionsFor(SearchEvents.SearchResult)).toBe(2);
      });

      it('includes the correct game payload in search:result', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(
          of(
            makeResultFrame({
              game: {
                externalId: '174430',
                title: 'Gloomhaven',
                contentType: ContentType.CONTENT_TYPE_BASE_GAME,
              } as GameSearchData,
            }),
            makeSourceDone(),
          ),
        );

        await gateway.handleSearchStart(client, makeStartDto());

        const payload = assertEmitted<WsSearchResultPayload>(room('corr-1'), SearchEvents.SearchResult);
        expect(payload.source).toBe('bgg-gw-1');
        expect(payload.games[0].externalId).toBe('174430');
        expect(payload.games[0].title).toBe('Gloomhaven');
      });

      it('sets inSystem=true on search:result when coordinator marks the game as in-system', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(
          of(makeResultFrame({ inSystem: true, gameId: 'db-game-uuid' }), makeSourceDone()),
        );

        await gateway.handleSearchStart(client, makeStartDto());

        const payload = assertEmitted<WsSearchResultPayload>(room('corr-1'), SearchEvents.SearchResult);
        expect(payload.games[0].inSystem).toBe(true);
        expect(payload.games[0].gameId).toBe('db-game-uuid');
      });

      it('emits search:source_done with the gateway source for RESULT_STATUS_SOURCE_DONE', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone('corr-1', 'bgg-gw-1')));

        await gateway.handleSearchStart(client, makeStartDto());

        assertEmitted<WsSourceDonePayload>(room('corr-1'), SearchEvents.SearchSourceDone, {
          correlationId: 'corr-1',
          source: 'bgg-gw-1',
        });
      });

      it('emits search:rate_limited with retryAfter for RESULT_STATUS_RATE_LIMITED', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(
          of(
            {
              correlationId: 'corr-1',
              gatewayId: 'bgg-gw-1',
              status: ResultStatus.RESULT_STATUS_RATE_LIMITED,
              retryAfter: 30,
              message: 'Too many requests',
            } satisfies SearchGameResult,
            makeSourceDone(),
          ),
        );

        await gateway.handleSearchStart(client, makeStartDto());

        assertEmitted<WsRateLimitedPayload>(room('corr-1'), SearchEvents.SearchRateLimited, {
          correlationId: 'corr-1',
          source: 'bgg-gw-1',
          retryAfter: 30,
        });
      });

      it('uses a default retryAfter of 60 when the frame omits it', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(
          of(
            {
              correlationId: 'corr-1',
              gatewayId: 'bgg-gw-1',
              status: ResultStatus.RESULT_STATUS_RATE_LIMITED,
            } satisfies SearchGameResult,
            makeSourceDone(),
          ),
        );

        await gateway.handleSearchStart(client, makeStartDto());

        const payload = assertEmitted<WsRateLimitedPayload>(room('corr-1'), SearchEvents.SearchRateLimited);
        expect(payload.retryAfter).toBe(60);
      });

      it('emits search:unavailable for RESULT_STATUS_UNAVAILABLE', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(
          of(
            {
              correlationId: 'corr-1',
              gatewayId: 'bgg-gw-1',
              status: ResultStatus.RESULT_STATUS_UNAVAILABLE,
            } satisfies SearchGameResult,
            makeSourceDone(),
          ),
        );

        await gateway.handleSearchStart(client, makeStartDto());

        assertEmitted(room('corr-1'), SearchEvents.SearchUnavailable, {
          correlationId: 'corr-1',
          source: 'bgg-gw-1',
        });
      });

      it('emits search:error for RESULT_STATUS_ERROR frames, including the message', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(
          of(
            {
              correlationId: 'corr-1',
              gatewayId: 'bgg-gw-1',
              status: ResultStatus.RESULT_STATUS_ERROR,
              message: 'Upstream BGG failure',
            } satisfies SearchGameResult,
            makeSourceDone(),
          ),
        );

        await gateway.handleSearchStart(client, makeStartDto());

        assertEmitted<WsSearchErrorPayload>(room('corr-1'), SearchEvents.SearchError, {
          correlationId: 'corr-1',
          source: 'bgg-gw-1',
          message: 'Upstream BGG failure',
        });
      });
    });

    describe('stream completion', () => {
      it('emits search:done when the coordinator stream completes', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));

        await gateway.handleSearchStart(client, makeStartDto());

        assertEmitted(room('corr-1'), SearchEvents.SearchDone, { correlationId: 'corr-1' });
      });

      it('sends search:done after the local results, however fast the coordinator stream completes', async () => {
        // `of(...)` completes the gateway half synchronously, while the local
        // half still has the actor's abilities and the query to wait on.
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));
        db.game.findMany.mockResolvedValue([makeGameWithSource()]);

        await gateway.handleSearchStart(client, makeStartDto({ includeLocal: true }));

        const events = mockEmit.mock.calls.map(([event]) => event);
        expect(events.filter((event) => event === SearchEvents.SearchDone)).toHaveLength(1);
        expect(events.at(-1)).toBe(SearchEvents.SearchDone);
        expect(events).toContain(SearchEvents.SearchResult);
      });

      it('ends a local-only search with search:done', async () => {
        const client = makeSocket(gateway);
        db.game.findMany.mockResolvedValue([]);

        await gateway.handleSearchStart(client, makeStartDto({ includeLocal: true, includeExternal: false }));

        assertEmitted(room('corr-1'), SearchEvents.SearchDone, { correlationId: 'corr-1' });
      });

      it('removes the subscription from activeSearches after stream completion', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));

        await gateway.handleSearchStart(client, makeStartDto());

        expect(clientData(gateway, client).activeSearches.has('corr-1')).toBe(false);
      });

      it('leaves the correlationId room after stream completion', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));

        await gateway.handleSearchStart(client, makeStartDto());

        expect(client.leave).toHaveBeenCalledWith(room('corr-1'));
      });

      it('always emits to the correlationId room, not directly to the socket', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(of(makeSourceDone()));

        await gateway.handleSearchStart(client, makeStartDto());

        // Every emission should go via server.to(<socket>:<correlationId>)
        for (const [target] of mockTo.mock.calls) {
          expect(target).toBe(room('corr-1'));
        }
      });
    });

    describe('stream error handling', () => {
      it('emits search:error with source="coordinator" when the gRPC stream errors', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(throwError(() => new Error('gRPC transport failure')));

        await gateway.handleSearchStart(client, makeStartDto());

        assertEmitted<WsSearchErrorPayload>(room('corr-1'), SearchEvents.SearchError, {
          correlationId: 'corr-1',
          source: 'coordinator',
        });
      });

      it('resolves (does not throw) when the gRPC stream errors', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(throwError(() => new Error('connection reset')));

        await expect(gateway.handleSearchStart(client, makeStartDto())).resolves.toBeUndefined();
      });

      // TODO: we don't want to remove all searches on stream error - multiple game gateways could
      // be active under the same correlationId, and one gateway error shouldn't cancel them all.
      it.skip('cleans up the subscription from activeSearches on stream error', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(throwError(() => new Error('gRPC error')));

        await gateway.handleSearchStart(client, makeStartDto());

        expect(clientData(gateway, client).activeSearches.has('corr-1')).toBe(false);
      });

      it('leaves the correlationId room on stream error', async () => {
        const client = makeSocket(gateway);
        coordinator.searchGames.mockReturnValue(throwError(() => new Error('gRPC error')));

        await gateway.handleSearchStart(client, makeStartDto());

        expect(client.leave).toHaveBeenCalledWith(room('corr-1'));
      });
    });

    describe('concurrent searches', () => {
      it('allows two searches with different correlationIds on the same socket', async () => {
        const client = makeSocket(gateway);

        coordinator.searchGames.mockReturnValueOnce(of(makeSourceDone('corr-1')));
        await gateway.handleSearchStart(client, makeStartDto({ correlationId: 'corr-1' }));

        coordinator.searchGames.mockReturnValueOnce(of(makeSourceDone('corr-2')));
        await gateway.handleSearchStart(client, makeStartDto({ correlationId: 'corr-2' }));

        expect(coordinator.searchGames).toHaveBeenCalledTimes(2);
        expect(client.join).toHaveBeenCalledWith(room('corr-1'));
        expect(client.join).toHaveBeenCalledWith(room('corr-2'));
      });

      it('refuses a second search with the same correlationId while a local-only one is still running', async () => {
        const client = makeSocket(gateway);
        const local = deferred<never[]>();
        db.game.findMany.mockReturnValueOnce(local.promise as never);

        const first = gateway.handleSearchStart(client, makeStartDto({ includeLocal: true, includeExternal: false }));
        await gateway.handleSearchStart(client, makeStartDto({ includeLocal: true, includeExternal: false }));

        assertEmitted<WsSearchErrorPayload>(room('corr-1'), SearchEvents.SearchError, {
          message: `Search with correlationId corr-1 is already active`,
        });

        local.resolve([]);
        await first;
        expect(db.game.findMany).toHaveBeenCalledTimes(1);
      });

      it('keeps two sockets that send the same correlationId in rooms of their own', async () => {
        // The id is the client's choice, and local results depend on who asked
        // (#472): a room shared by id would hand one user's private games to
        // every other socket that sent it.
        const mine = makeSocket(gateway);
        const theirs = makeSocket(gateway, 'socket-test-2');
        db.game.findMany.mockResolvedValue([makeGameWithSource()]);

        await gateway.handleSearchStart(mine, makeStartDto({ includeLocal: true, includeExternal: false }));
        await gateway.handleSearchStart(theirs, makeStartDto({ includeLocal: true, includeExternal: false }));

        expect(mine.join).toHaveBeenCalledWith(room('corr-1'));
        expect(theirs.join).toHaveBeenCalledWith('socket-test-2:corr-1');
        expect(mockTo).not.toHaveBeenCalledWith('corr-1');
      });
    });
  });

  describe('handleSearchCancel()', () => {
    it('does nothing when the correlationId has no active search', () => {
      const client = makeSocket(gateway);
      expect(() => gateway.handleSearchCancel(client, makeCancelDto('not-active'))).not.toThrow();
      expect(client.leave).not.toHaveBeenCalled();
    });

    it('unsubscribes from the active gRPC stream', () => {
      const client = makeSocket(gateway);
      const sub = seedActiveSearch(gateway, client);

      gateway.handleSearchCancel(client, makeCancelDto());

      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('removes the correlationId from activeSearches', () => {
      const client = makeSocket(gateway);
      seedActiveSearch(gateway, client);

      gateway.handleSearchCancel(client, makeCancelDto());

      expect(clientData(gateway, client).activeSearches.has('corr-1')).toBe(false);
    });

    it('leaves the correlationId room', () => {
      const client = makeSocket(gateway);
      seedActiveSearch(gateway, client);

      gateway.handleSearchCancel(client, makeCancelDto());

      expect(client.leave).toHaveBeenCalledWith(room('corr-1'));
    });

    it('ends a running search without search:done, so its start handler settles', async () => {
      const client = makeSocket(gateway);
      coordinator.searchGames.mockReturnValue(NEVER);

      const started = gateway.handleSearchStart(client, makeStartDto());
      await flushMicrotasks();
      gateway.handleSearchCancel(client, makeCancelDto());

      await expect(started).resolves.toBeUndefined();
      expect(countEmissionsFor(SearchEvents.SearchDone)).toBe(0);
      expect(clientData(gateway, client).activeSearches.has('corr-1')).toBe(false);
    });

    it('does not affect other concurrent searches on the same socket', () => {
      const client = makeSocket(gateway);
      seedActiveSearch(gateway, client, 'corr-1');
      const sub2 = seedActiveSearch(gateway, client, 'corr-2');

      gateway.handleSearchCancel(client, makeCancelDto('corr-1'));

      expect(sub2.unsubscribe).not.toHaveBeenCalled();
      expect(clientData(gateway, client).activeSearches.has('corr-2')).toBe(true);
    });
  });
});

function makeStartDto(overrides: Partial<SearchStartDto> = {}): SearchStartDto {
  return Object.assign(new SearchStartDto(), {
    correlationId: 'corr-1',
    query: 'Gloomhaven',
    gatewayIds: ['bgg-gw-1'],
    includeLocal: false, // opt-in per test so DB mocking stays explicit
    includeExternal: true,
    ...overrides,
  });
}

/** The room {@link makeSocket}'s frames for `correlationId` are emitted to. */
function room(correlationId: string): string {
  return `${SOCKET_ID}:${correlationId}`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));

  return { promise, resolve };
}

/** Lets the handler run up to the point it waits on the coordinator stream. */
function flushMicrotasks(): Promise<void> {
  return new Promise((settle) => setImmediate(settle));
}

function makeCancelDto(correlationId = 'corr-1'): SearchCancelDto {
  return Object.assign(new SearchCancelDto(), { correlationId });
}

/**
 * A RESULT frame from one of the configured gateways
 */
function makeResultFrame(overrides: Partial<SearchGameResult> = {}): SearchGameResult {
  return {
    correlationId: 'corr-1',
    gatewayId: 'bgg-gw-1',
    status: ResultStatus.RESULT_STATUS_RESULT,
    game: {
      externalId: '174430',
      title: 'Gloomhaven',
      contentType: ContentType.CONTENT_TYPE_BASE_GAME,
      availablePlatforms: [],
      availableReleases: [],
    } as GameSearchData,
    inSystem: false,
    ...overrides,
  };
}
/**
 * A SOURCE_DONE sentinel that terminates a gateway stream
 */
function makeSourceDone(correlationId = 'corr-1', gatewayId = 'bgg-gw-1'): SearchGameResult {
  return { correlationId, gatewayId, status: ResultStatus.RESULT_STATUS_SOURCE_DONE };
}

/**
 * Creates a minimal socket.io Socket double.
 * `as unknown as Socket` is intentional — we only need the subset of the
 * socket surface that GameSearchGateway actually touches.
 */
function makeSocket(gateway: GameSearchGateway, id = SOCKET_ID): Socket {
  const socket = {
    id,
    rooms: new Set<string>([id]),
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockReturnThis(),
  } as unknown as Socket;

  socket.data = Object.assign((gateway as any).userQueryMap.get(socket), {
    userId: SOCKET_USER_ID,
    actor: { kind: 'user', userId: SOCKET_USER_ID },
    correlationId: 'connection-correlation-id',
  });
  return socket;
}

function clientData(gateway: GameSearchGateway, socket: Socket): WsClientData {
  return (gateway as any).userQueryMap.get(socket) as WsClientData;
}

/**
 * Injects a pre-built stub subscription into a socket as if a search had
 * already started. Returns the stub for assertion purposes.
 */
function seedActiveSearch(
  gateway: GameSearchGateway,
  socket: Socket,
  correlationId = 'corr-1',
): jest.Mocked<Pick<Subscription, 'unsubscribe'>> {
  const sub = { unsubscribe: jest.fn() } as unknown as jest.Mocked<Pick<Subscription, 'unsubscribe'>>;

  clientData(gateway, socket).activeSearches.set(correlationId, sub as unknown as Subscription);

  return sub;
}
