import { type Actor, AuditContextModule, getActorSnapshotFromCls } from '@bge/actor-context';
import { injectActorContextMetadata, WsActorScope } from '@bge/actor-context-transport';
import { AuthService } from '@bge/auth';
import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, DatabaseModule, DatabaseService, ResourceType } from '@bge/database';
import { GameSearchService, SearchEvents } from '@bge/game-search';
import {
  AbilityService,
  PermissionsModule,
  PermissionsService,
  PoliciesGuard,
  type UserWithRoles,
} from '@bge/permissions';
import { BGE_ACTOR_HEADER, WsErrorEvents, type WsErrorPayload } from '@bge/shared';
import { Metadata } from '@grpc/grpc-js';
import { type CanActivate, type INestApplication, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SubscribeMessage, WebSocketGateway, WsException } from '@nestjs/websockets';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { ClsModule } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Observable } from 'rxjs';
import { type Socket as ClientSocket, io } from 'socket.io-client';
import { WsErrorFilter } from '../filters';
import { GameSearchGateway } from '../game/search.gateway';
import { AuthenticatedGateway } from './authenticated.gateway';
import { WsFrameScope } from './ws-frame-scope';

const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_WITHOUT_READ = 'user-without-read';
const USER_WITHOUT_ROLE_GRAPH = 'user-without-role-graph';

/** Each token authenticates as the user of the same name; one fails its lookup. */
const OUTAGE_TOKEN = 'token-outage';

/**
 * A role graph whose only grant reads the games its holder created, so the
 * conditions a query receives name the user whose abilities built them.
 */
function roleGraph(userId: string, canRead: boolean): UserWithRoles {
  const readOwnGames = {
    action: Action.read,
    subject: ResourceType.Game,
    conditions: { createdById: '{{user.id}}' },
    fields: [],
    inverted: false,
  };

  return {
    id: userId,
    householdMember: [],
    eventsAttended: [],
    permissions: [],
    roles: canRead ? [{ role: { name: 'User', permissions: [{ permission: readOwnGames }] } }] : [],
  } as unknown as UserWithRoles;
}

const userActor = (userId: string): Actor => ({ kind: 'user', userId });

/** The read conditions {@link roleGraph} gives `userId`, as CASL renders them for Prisma. */
const readConditionsOf = (userId: string) => [{ OR: [{ createdById: userId }] }];

/**
 * A session lookup that can be held open, so a client's first frame reaches
 * the server while its connection is still being authenticated.
 */
class GatedAuthService {
  private gate: Promise<void> = Promise.resolve();
  private release: () => void = () => undefined;
  private markLookupStarted: () => void = () => undefined;

  /** Resolves once a held lookup has begun. */
  lookupStarted: Promise<void> = Promise.resolve();

  /** Holds every lookup until the returned function is called. */
  hold(): () => void {
    this.gate = new Promise<void>((settle) => (this.release = settle));
    this.lookupStarted = new Promise<void>((settle) => (this.markLookupStarted = settle));

    return () => this.release();
  }

  async getSessionFromToken(token: string) {
    this.markLookupStarted();
    await this.gate;

    if (token === OUTAGE_TOKEN) {
      throw new Error('connect ECONNREFUSED redis:6379');
    }

    return {
      user: { id: token.replace(/^token-/, ''), isAnonymous: false },
      session: { expiresAt: new Date(Date.now() + 60_000) },
    };
  }

  isValidSession(session: unknown): boolean {
    return session !== null && session !== undefined;
  }
}

let unscopedHandlerRan = false;

/**
 * A gateway that overrides `afterInit` without calling the base's, so none
 * of its connections is authenticated.
 */
@WebSocketGateway({ namespace: 'unauthenticated' })
class UnauthenticatedGateway extends AuthenticatedGateway {
  protected readonly logger = new Logger(UnauthenticatedGateway.name);

  override afterInit(): void {
    // Deliberately empty.
  }
}

/**
 * A gateway that overrides both `afterInit` and `handleConnection` without
 * calling the base's, so its connections stay open and none of their frames
 * runs inside an actor scope.
 */
@WebSocketGateway({ namespace: 'unscoped' })
class UnscopedGateway extends AuthenticatedGateway {
  protected readonly logger = new Logger(UnscopedGateway.name);

  override afterInit(): void {
    // Deliberately empty.
  }

  override handleConnection(): void {
    // Deliberately empty.
  }

  @SubscribeMessage('ping')
  ping() {
    unscopedHandlerRan = true;
    return { event: 'pong', data: {} };
  }
}

@Module({ providers: [{ provide: DatabaseService, useValue: {} }], exports: [DatabaseService] })
class StubDatabaseModule {}

/**
 * What a frame runs inside, over a real socket.io server and client (#427,
 * #498): the actor its connection authenticated as, and that actor's
 * abilities, in every guard, the handler, and the exception filter.
 *
 * Only an in-process test can hold the session lookup open while a client
 * sends its first frame, which is what exposes the window between the
 * connection and its actor. Over the shipped bundle the lookup nearly always
 * wins the race, so an e2e passes whether or not the window exists.
 */
describe('AuthenticatedGateway (over a real socket)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let auth: GatedAuthService;
  let abilityService: AbilityService;
  const sockets: ClientSocket[] = [];

  /** Users whose read grant has been taken away since they connected. */
  const revoked = new Set<string>();
  const getUserRoleGraph = jest.fn(async (userId: string) => {
    if (userId === USER_WITHOUT_ROLE_GRAPH) {
      throw new Error('role graph unavailable');
    }

    return roleGraph(userId, userId !== USER_WITHOUT_READ && !revoked.has(userId));
  });

  /** Users whose session has ended since they connected. */
  const endedSessions = new Set<string>();

  /**
   * Stands in for `AuthGuard`, recording the actor each frame runs as when it
   * checks the frame's session, and refusing a session that has ended the way
   * `AuthGuard` does.
   */
  const authGuardSaw: (Actor | null)[] = [];
  const recordingAuthGuard: CanActivate = {
    canActivate: () => {
      const actor = getActorSnapshotFromCls().actor ?? null;
      authGuardSaw.push(actor);
      if (actor?.kind === 'user' && endedSessions.has(actor.userId)) {
        throw new WsException('UNAUTHORIZED');
      }

      return true;
    },
  };

  /** What `PoliciesGuard` read on each frame: the actor, and the rules of its abilities. */
  const policiesGuardSaw: { actor: Actor | null; abilityRules: unknown[] }[] = [];

  /** The rules of the abilities an explicit resolution gives `userId`. */
  const resolvedAbilityRules = async (userId: string) =>
    (await abilityService.resolveAbilitiesForActor(userActor(userId))).map((ability) => ability.rules);

  const queryLocalGames = jest.fn<Promise<never[]>, [query: string, conditions: unknown[]]>(async () => []);

  /** The actor each coordinator call would carry on its `x-bge-actor` header. */
  const coordinatorSaw: (Actor | null)[] = [];
  const searchGames = jest.fn(
    () =>
      new Observable<never>((subscriber) => {
        // What the coordinator client's outbound interceptor sends, computed
        // where the call is made.
        const metadata = new Metadata();
        injectActorContextMetadata(metadata);
        const [header] = metadata.get(BGE_ACTOR_HEADER);
        coordinatorSaw.push(header ? JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')) : null);
        subscriber.complete();
      }),
  );

  /** The actor each call to the exception filter ran as. */
  const filterSaw: (Actor | null)[] = [];

  beforeAll(async () => {
    const filterCatch = WsErrorFilter.prototype.catch;
    jest.spyOn(WsErrorFilter.prototype, 'catch').mockImplementation(function (this: WsErrorFilter, ...args) {
      filterSaw.push(getActorSnapshotFromCls().actor ?? null);
      return filterCatch.apply(this, args);
    });

    const policiesCanActivate = PoliciesGuard.prototype.canActivate;
    jest.spyOn(PoliciesGuard.prototype, 'canActivate').mockImplementation(function (this: PoliciesGuard, ...args) {
      policiesGuardSaw.push({
        actor: getActorSnapshotFromCls().actor ?? null,
        abilityRules: abilityService.getCurrentAbilities().map((ability) => ability.rules),
      });
      return policiesCanActivate.apply(this, args);
    });

    auth = new GatedAuthService();

    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true }), AuditContextModule, PermissionsModule],
      providers: [
        WsActorScope,
        WsFrameScope,
        GameSearchGateway,
        UnauthenticatedGateway,
        UnscopedGateway,
        { provide: AuthService, useValue: auth },
        { provide: GameSearchService, useValue: { queryLocalGames } },
        { provide: GatewayCoordinatorClientService, useValue: { searchGames } },
      ],
    })
      .overrideModule(DatabaseModule)
      .useModule(StubDatabaseModule)
      .overrideProvider(PermissionsService)
      .useValue({ getUserRoleGraph })
      .overrideGuard(AuthGuard)
      .useValue(recordingAuthGuard)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    abilityService = app.get(AbilityService);
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.disconnect();
    }

    revoked.clear();
    endedSessions.clear();
    authGuardSaw.length = 0;
    policiesGuardSaw.length = 0;
    filterSaw.length = 0;
    coordinatorSaw.length = 0;
    unscopedHandlerRan = false;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** A socket authenticating as `userId`, not yet connected. */
  const socketAs = (userId: string, namespace = 'games/search'): ClientSocket => {
    const socket = io(`${baseUrl}/${namespace}`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
      auth: { token: `token-${userId}` },
    });
    sockets.push(socket);

    return socket;
  };

  const connected = async (socket: ClientSocket): Promise<ClientSocket> => {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });

    return socket;
  };

  const searchStart = (overrides: Record<string, unknown> = {}) => ({
    correlationId: randomUUID(),
    query: 'Gloomhaven',
    includeLocal: true,
    includeExternal: false,
    ...overrides,
  });

  /**
   * Resolves with the `search:error` frames a search sent, once its
   * `search:done` arrives. Rejects if the search is refused or the
   * connection fails, so a test fails naming what happened rather than
   * timing out.
   */
  const searchOutcome = (socket: ClientSocket, correlationId: string) =>
    new Promise<{ errors: unknown[] }>((resolve, reject) => {
      const errors: unknown[] = [];
      socket.on(SearchEvents.SearchError, (payload: { correlationId: string }) => {
        if (payload.correlationId === correlationId) {
          errors.push(payload);
        }
      });
      socket.on(SearchEvents.SearchDone, (payload: { correlationId: string }) => {
        if (payload.correlationId === correlationId) {
          resolve({ errors });
        }
      });
      socket.on(WsErrorEvents.Exception, (payload: WsErrorPayload) => {
        if (payload.correlationId === correlationId) {
          reject(new Error(`Search refused: ${JSON.stringify(payload)}`));
        }
      });
      socket.on('connect_error', (error: Error) => reject(error));
    });

  /**
   * Resolves with the refusal a frame is answered with, and rejects if it is
   * served instead. Given a correlation id, only that search's frames count.
   */
  const refusalOf = (socket: ClientSocket, correlationId?: string) =>
    new Promise<WsErrorPayload>((resolve, reject) => {
      const ours = (payload: { correlationId?: string }) =>
        correlationId === undefined || payload.correlationId === correlationId;
      const served = () => reject(new Error('The frame was served, not refused'));

      socket.on(WsErrorEvents.Exception, (payload: WsErrorPayload) => ours(payload) && resolve(payload));
      socket.on(SearchEvents.SearchDone, (payload: { correlationId: string }) => ours(payload) && served());
      socket.once('pong', served);
    });

  describe('frames sent before their connection is accepted', () => {
    it("run as the socket's user in every guard, the handler, the coordinator call and the filter", async () => {
      const release = auth.hold();
      const socket = socketAs(USER_A);
      const served = searchStart({ includeExternal: true, gatewayIds: ['bgg-gw-1'] });
      const refused = searchStart({ includeLocal: false });
      const outcome = searchOutcome(socket, served.correlationId);
      const refusal = refusalOf(socket, refused.correlationId);

      socket.connect();
      socket.emit(SearchEvents.SearchStart, served);
      socket.emit(SearchEvents.SearchStart, refused);

      // Long enough for the frames to be handled already, if the server lets
      // them through before the connection's lookup has finished.
      await auth.lookupStarted;
      await delay(100);
      release();

      expect(await outcome).toEqual({ errors: [] });
      expect(await refusal).toMatchObject({ statusCode: 400, correlationId: refused.correlationId });
      expect(authGuardSaw).toEqual([userActor(USER_A), userActor(USER_A)]);
      expect(policiesGuardSaw.map(({ actor }) => actor)).toEqual([userActor(USER_A), userActor(USER_A)]);
      expect(queryLocalGames.mock.calls.map(([, conditions]) => conditions)).toEqual([readConditionsOf(USER_A)]);
      expect(coordinatorSaw).toEqual([userActor(USER_A)]);
      expect(filterSaw).toEqual([userActor(USER_A)]);
    });
  });

  describe('a connected socket', () => {
    it("reads with its own user's abilities, never another socket's", async () => {
      const [mine, theirs] = await Promise.all([connected(socketAs(USER_A)), connected(socketAs(USER_B))]);
      const [myFrame, theirFrame] = [searchStart({ query: 'mine' }), searchStart({ query: 'theirs' })];
      const outcomes = [searchOutcome(mine, myFrame.correlationId), searchOutcome(theirs, theirFrame.correlationId)];

      mine.emit(SearchEvents.SearchStart, myFrame);
      theirs.emit(SearchEvents.SearchStart, theirFrame);
      await Promise.all(outcomes);

      const conditionsByQuery = new Map(queryLocalGames.mock.calls.map(([query, conditions]) => [query, conditions]));
      expect(conditionsByQuery).toEqual(
        new Map([
          ['mine', readConditionsOf(USER_A)],
          ['theirs', readConditionsOf(USER_B)],
        ]),
      );

      // PoliciesGuard read the abilities an explicit resolution gives the same actor.
      const rulesByActor = new Map(policiesGuardSaw.map(({ actor, abilityRules }) => [actor, abilityRules]));
      expect(rulesByActor).toEqual(
        new Map([
          [userActor(USER_A), await resolvedAbilityRules(USER_A)],
          [userActor(USER_B), await resolvedAbilityRules(USER_B)],
        ]),
      );
    });

    it('stops reading with a grant revoked while it stays connected, from its next frame', async () => {
      const socket = await connected(socketAs(USER_A));
      const before = searchStart();
      const beforeOutcome = searchOutcome(socket, before.correlationId);
      socket.emit(SearchEvents.SearchStart, before);
      expect(await beforeOutcome).toEqual({ errors: [] });

      revoked.add(USER_A);
      const after = searchStart();
      const refusal = refusalOf(socket, after.correlationId);
      socket.emit(SearchEvents.SearchStart, after);

      expect(await refusal).toMatchObject({ statusCode: 403, correlationId: after.correlationId });
      expect(queryLocalGames).toHaveBeenCalledTimes(1);
    });

    it('is refused a search with 403 when its user may not read games, before the handler runs', async () => {
      const socket = await connected(socketAs(USER_WITHOUT_READ));
      const refused = refusalOf(socket);

      socket.emit(SearchEvents.SearchStart, searchStart());

      expect(await refused).toMatchObject({ statusCode: 403, pattern: SearchEvents.SearchStart });
      expect(queryLocalGames).not.toHaveBeenCalled();
    });

    it("is answered with a 500 when its user's abilities cannot be resolved, and the handler never runs", async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const socket = await connected(socketAs(USER_WITHOUT_ROLE_GRAPH));
      const refused = refusalOf(socket);
      const frame = searchStart({ includeExternal: true });

      socket.emit(SearchEvents.SearchStart, frame);

      expect(await refused).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal server error',
        pattern: SearchEvents.SearchStart,
        correlationId: frame.correlationId,
      });
      expect(queryLocalGames).not.toHaveBeenCalled();
      expect(searchGames).not.toHaveBeenCalled();

      // The log names what failed, not merely that nothing was primed.
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining(SearchEvents.SearchStart),
        expect.objectContaining({ message: 'role graph unavailable' }),
      );
      logged.mockRestore();
    });

    it('is told its session has ended before any of its abilities are looked up', async () => {
      // This user's abilities cannot be resolved either, so a lookup made
      // first would answer the frame with a 500 and leave the socket open.
      const socket = await connected(socketAs(USER_WITHOUT_ROLE_GRAPH));
      endedSessions.add(USER_WITHOUT_ROLE_GRAPH);
      const told = new Promise<WsErrorPayload>((resolve, reject) => {
        socket.once(WsErrorEvents.AuthError, resolve);
        socket.once(WsErrorEvents.Exception, (payload: WsErrorPayload) =>
          reject(new Error(`Refused as a live session: ${JSON.stringify(payload)}`)),
        );
      });

      socket.emit(SearchEvents.SearchStart, searchStart());

      expect(await told).toMatchObject({ statusCode: 401, pattern: SearchEvents.SearchStart });
      expect(getUserRoleGraph).not.toHaveBeenCalled();
    });

    it('resolves no abilities for a frame no handler listens for', async () => {
      const socket = await connected(socketAs(USER_A));
      const frame = searchStart();
      const answered = searchOutcome(socket, frame.correlationId);

      socket.emit('made:up', { anything: true });
      socket.emit(SearchEvents.SearchStart, frame);

      // The unknown frame arrives first, so had it been primed, its lookup
      // would have begun before the search's.
      await answered;
      expect(getUserRoleGraph).toHaveBeenCalledTimes(1);
    });
  });

  describe('a refused connection', () => {
    it('is told on `connect_error` with a 500 when its session cannot be looked up', async () => {
      const socket = io(`${baseUrl}/games/search`, {
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
        auth: { token: OUTAGE_TOKEN },
      });
      sockets.push(socket);

      const error = await new Promise<Error & { data?: unknown }>((resolve, reject) => {
        socket.once('connect_error', resolve);
        socket.once('connect', () => reject(new Error('The connection was accepted')));
      });

      expect(error.message).toBe('Internal server error');
      expect(error.data).toEqual({ statusCode: 500, error: 'Internal Server Error', message: 'Internal server error' });
      expect(socket.active).toBe(false);
    });
  });

  describe('a gateway whose afterInit skips the base class', () => {
    it('closes each connection, which was never authenticated, and logs why', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const socket = socketAs(USER_A, 'unauthenticated');
      const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));

      socket.connect();

      expect(await closed).toBe('io server disconnect');
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('never authenticated'));
      logged.mockRestore();
    });

    it('refuses every frame with a 500 when handleConnection skips it too, and logs why', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const socket = await connected(socketAs(USER_A, 'unscoped'));
      const refused = refusalOf(socket);

      socket.emit('ping', {});

      expect(await refused).toMatchObject({ statusCode: 500, pattern: 'ping' });
      expect(unscopedHandlerRan).toBe(false);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('ping'),
        expect.objectContaining({ message: 'WebSocket frame is not running as an actor' }),
      );
      logged.mockRestore();
    });
  });
});
