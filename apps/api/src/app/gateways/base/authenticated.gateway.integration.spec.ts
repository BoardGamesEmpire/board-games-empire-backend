import { type Actor, AuditContextModule, getActorSnapshotFromCls } from '@bge/actor-context';
import { injectActorContextMetadata, WsActorScope } from '@bge/actor-context-transport';
import { AuthService } from '@bge/auth';
import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, DatabaseModule, DatabaseService, ResourceType } from '@bge/database';
import { GameSearchService, SearchEvents } from '@bge/game-search';
import {
  FALLBACK_LOCALE,
  I18N_CATALOG_DIR,
  type I18nTranslations,
  i18nValidationMessage,
  type LocaleResolutionInput,
  LocaleResolutionService,
} from '@bge/i18n';
import {
  AbilityService,
  PermissionsModule,
  PermissionsService,
  PoliciesGuard,
  type UserWithRoles,
} from '@bge/permissions';
import { BGE_ACTOR_HEADER, WsErrorEvents, type WsErrorPayload } from '@bge/shared';
import { Metadata } from '@grpc/grpc-js';
import { type INestApplication, Logger, Module, UsePipes } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorageService } from '@nestjs/throttler';
import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { IsString } from 'class-validator';
import { ClsModule } from 'nestjs-cls';
import { I18nModule, I18nService, I18nValidationPipe } from 'nestjs-i18n';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Observable } from 'rxjs';
import { type Socket as ClientSocket, io } from 'socket.io-client';
import { createThrottlers } from '../../lib/throttlers';
import { WsErrorFilter } from '../filters';
import { GameSearchGateway } from '../game/search.gateway';
import { AuthenticatedGateway } from './authenticated.gateway';
import { WsFrameScope } from './ws-frame-scope';
import { WsSessionGuard } from './ws-session';
import { WsTranslator } from './ws-translator';

const USER_A = 'user-a';
const USER_B = 'user-b';
const USER_WITHOUT_READ = 'user-without-read';
const USER_WITHOUT_ROLE_GRAPH = 'user-without-role-graph';

/** Each token authenticates as the user of the same name; one fails its lookup. */
const OUTAGE_TOKEN = 'token-outage';

/**
 * How many frames one user may send one handler in the throttle window. Low
 * enough for a test to reach: no other test sends one handler more than two
 * frames as one user, and the counts are cleared after each test.
 */
const FRAME_LIMIT = 3;

/** The app's own throttler tiers, at {@link FRAME_LIMIT}. */
const THROTTLE_CONFIG: Record<string, number> = {
  'throttle.ttlMs': 60_000,
  'throttle.limit': FRAME_LIMIT,
  'throttle.trustedProxyHops': 0,
};

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
 * the server while its connection is still being authenticated. Each bearer
 * token names the user of the same name, and a user's session is gone once
 * it is in `endedSessions`.
 */
class GatedAuthService {
  private gate: Promise<void> = Promise.resolve();
  private release: () => void = () => undefined;
  private markLookupStarted: () => void = () => undefined;

  /** Resolves once a held lookup has begun. */
  lookupStarted: Promise<void> = Promise.resolve();

  /** The headers each lookup was given, in order. */
  readonly lookups: IncomingHttpHeaders[] = [];

  constructor(private readonly endedSessions: ReadonlySet<string>) {}

  /** Holds every lookup until the returned function is called. */
  hold(): () => void {
    this.gate = new Promise<void>((settle) => (this.release = settle));
    this.lookupStarted = new Promise<void>((settle) => (this.markLookupStarted = settle));

    return () => this.release();
  }

  async getSessionFromHeaders(headers: IncomingHttpHeaders) {
    this.lookups.push(headers);
    this.markLookupStarted();
    await this.gate;

    const token = headers.authorization?.replace(/^Bearer /, '');
    if (token === OUTAGE_TOKEN) {
      throw new Error('connect ECONNREFUSED redis:6379');
    }

    const userId = token?.replace(/^token-/, '');
    if (!userId || this.endedSessions.has(userId)) {
      return null;
    }

    return {
      user: { id: userId, isAnonymous: false },
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

/** A frame whose validator names a catalog key, as the search DTOs' do (#503). */
class MarkedDto {
  @IsString({ message: i18nValidationMessage('validation.isString') })
  query!: string;
}

@WebSocketGateway({ namespace: 'marked' })
class MarkedGateway extends AuthenticatedGateway {
  protected readonly logger = new Logger(MarkedGateway.name);

  @UsePipes(new I18nValidationPipe())
  @SubscribeMessage('mark')
  mark(@MessageBody() dto: MarkedDto) {
    return { event: 'marked', data: dto };
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

  const throttlerStorage = new ThrottlerStorageService();

  /** The actor each frame ran as when its session was checked. */
  const sessionGuardSaw: (Actor | null)[] = [];

  /** What `PoliciesGuard` read on each frame: the actor, and the rules of its abilities. */
  const policiesGuardSaw: { actor: Actor | null; abilityRules: unknown[] }[] = [];

  /** The rules of the abilities an explicit resolution gives `userId`. */
  const resolvedAbilityRules = async (userId: string) =>
    (await abilityService.resolveAbilitiesForActor(userActor(userId))).map((ability) => ability.rules);

  const queryLocalGames = jest.fn<
    Promise<never[]>,
    [query: string, conditions: unknown[], limit: number, offset: number]
  >(async () => []);

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

  /**
   * Stands in for the preference lookup, which needs the database. French is
   * treated as supported, so a French `Accept-Language` resolves to it.
   */
  const resolveLocale = jest.fn(async ({ acceptLanguage }: LocaleResolutionInput) =>
    acceptLanguage?.startsWith('fr') ? 'fr' : FALLBACK_LOCALE,
  );
  let i18n: I18nService<I18nTranslations>;

  beforeAll(async () => {
    const sessionCanActivate = WsSessionGuard.prototype.canActivate;
    jest.spyOn(WsSessionGuard.prototype, 'canActivate').mockImplementation(function (this: WsSessionGuard, ...args) {
      sessionGuardSaw.push(getActorSnapshotFromCls().actor ?? null);
      return sessionCanActivate.apply(this, args);
    });

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

    auth = new GatedAuthService(endedSessions);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true }),
        AuditContextModule,
        PermissionsModule,
        I18nModule.forRoot({
          fallbackLanguage: FALLBACK_LOCALE,
          loaderOptions: { path: I18N_CATALOG_DIR, watch: false },
        }),
        ThrottlerModule.forRoot({
          throttlers: createThrottlers({ getOrThrow: <T>(key: string) => THROTTLE_CONFIG[key] as T }),
          storage: throttlerStorage,
        }),
      ],
      providers: [
        WsActorScope,
        WsFrameScope,
        WsTranslator,
        GameSearchGateway,
        UnauthenticatedGateway,
        UnscopedGateway,
        MarkedGateway,
        { provide: LocaleResolutionService, useValue: { resolve: resolveLocale } },
        { provide: AuthService, useValue: auth },
        { provide: GameSearchService, useValue: { queryLocalGames } },
        { provide: GatewayCoordinatorClientService, useValue: { searchGames } },
      ],
    })
      .overrideModule(DatabaseModule)
      .useModule(StubDatabaseModule)
      .overrideProvider(PermissionsService)
      .useValue({ getUserRoleGraph })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    abilityService = app.get(AbilityService);
    i18n = app.get(I18nService);
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.disconnect();
    }

    revoked.clear();
    endedSessions.clear();
    // Its pending expiry timers first, which would otherwise fire on keys cleared here.
    throttlerStorage.onApplicationShutdown();
    throttlerStorage.storage.clear();
    auth.lookups.length = 0;
    sessionGuardSaw.length = 0;
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

  /**
   * A socket authenticating as `userId`, not yet connected. `headers` go on
   * its handshake beside the token.
   */
  const socketAs = (
    userId: string,
    namespace = 'games/search',
    acceptLanguage?: string,
    headers: Record<string, string> = {},
  ): ClientSocket => {
    const socket = io(`${baseUrl}/${namespace}`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
      auth: { token: `token-${userId}` },
      extraHeaders: { ...(acceptLanguage && { 'accept-language': acceptLanguage }), ...headers },
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
      expect(sessionGuardSaw).toEqual([userActor(USER_A), userActor(USER_A)]);
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

    // The search DTO resolves the local page size and the service keeps no
    // fallback, so this holds only while the handler's pipe turns the frame
    // into that DTO (#403).
    it("sizes a frame that names no limit at the search DTO's page size", async () => {
      const socket = await connected(socketAs(USER_A));
      const frame = searchStart();
      const outcome = searchOutcome(socket, frame.correlationId);

      socket.emit(SearchEvents.SearchStart, frame);

      expect(await outcome).toEqual({ errors: [] });
      expect(queryLocalGames).toHaveBeenCalledWith(frame.query, readConditionsOf(USER_A), 20, 0);
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

      // PoliciesGuard refuses with a catalog marker, which reached the client
      // as the bare class name "Forbidden Exception" until the filter
      // translated it (#180, #501).
      expect(await refused).toMatchObject({
        statusCode: 403,
        error: 'Forbidden',
        message: 'You do not have permission to perform this action.',
        pattern: SearchEvents.SearchStart,
      });
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

      // The copy the handshake gives the same session, not a bare
      // "Unauthorized" (#511).
      expect(await told).toMatchObject({
        statusCode: 401,
        message: 'Session expired or invalid',
        pattern: SearchEvents.SearchStart,
      });
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

  describe('the session each frame is checked against', () => {
    /** Another user's session, on the handshake headers beside the token. */
    const theirSession = { authorization: `Bearer token-${USER_B}`, cookie: `bge_auth_.session_token=token-${USER_B}` };

    it("is its connection's, whatever session its handshake headers name", async () => {
      const socket = await connected(socketAs(USER_A, 'games/search', undefined, theirSession));
      endedSessions.add(USER_B);
      const frame = searchStart();
      const outcome = searchOutcome(socket, frame.correlationId);

      socket.emit(SearchEvents.SearchStart, frame);

      expect(await outcome).toEqual({ errors: [] });
      expect(policiesGuardSaw.map(({ actor }) => actor)).toEqual([userActor(USER_A)]);
      expect(queryLocalGames.mock.calls.map(([, conditions]) => conditions)).toEqual([readConditionsOf(USER_A)]);
      // The connection's lookup and the frame's each saw the token alone.
      expect(auth.lookups).toEqual([
        { authorization: `Bearer token-${USER_A}` },
        { authorization: `Bearer token-${USER_A}` },
      ]);
    });

    it('refuses a frame once its own session ends, though its handshake headers name a live one', async () => {
      const socket = await connected(socketAs(USER_A, 'games/search', undefined, theirSession));
      endedSessions.add(USER_A);
      const told = new Promise<WsErrorPayload>((resolve) => socket.once(WsErrorEvents.AuthError, resolve));

      socket.emit(SearchEvents.SearchStart, searchStart());

      expect(await told).toMatchObject({ statusCode: 401, message: 'Session expired or invalid' });
      expect(queryLocalGames).not.toHaveBeenCalled();
    });
  });

  describe('a socket over its frame limit', () => {
    /** Sends `count` searches one after another, each of which must be served. */
    const searchesServed = async (socket: ClientSocket, count: number) => {
      for (let sent = 0; sent < count; sent++) {
        const frame = searchStart();
        const outcome = searchOutcome(socket, frame.correlationId);
        socket.emit(SearchEvents.SearchStart, frame);
        expect(await outcome).toEqual({ errors: [] });
      }
    };

    /** Sends one search more, and resolves with its refusal. */
    const overTheLimit = async (socket: ClientSocket) => {
      const frame = searchStart();
      const refusal = refusalOf(socket, frame.correlationId);
      socket.emit(SearchEvents.SearchStart, frame);

      return { frame, refusal: await refusal };
    };

    it('is refused the frame over the limit with a 429 on `exception`, and stays connected', async () => {
      const socket = await connected(socketAs(USER_A));
      const closed = jest.fn();
      socket.on('disconnect', closed);
      await searchesServed(socket, FRAME_LIMIT);

      const { frame, refusal } = await overTheLimit(socket);

      expect(refusal).toMatchObject({
        statusCode: 429,
        error: 'Too Many Requests',
        pattern: SearchEvents.SearchStart,
        correlationId: frame.correlationId,
      });
      // Long past the pause a 401 waits out before it disconnects.
      await delay(300);
      expect(closed).not.toHaveBeenCalled();
      expect(socket.connected).toBe(true);
    });

    it("leaves another user's frames alone", async () => {
      const [flooding, other] = await Promise.all([connected(socketAs(USER_A)), connected(socketAs(USER_B))]);
      await searchesServed(flooding, FRAME_LIMIT);
      expect((await overTheLimit(flooding)).refusal).toMatchObject({ statusCode: 429 });

      await searchesServed(other, 1);
    });

    it('refuses the frame before its session or its abilities are looked up', async () => {
      const socket = await connected(socketAs(USER_A));
      await searchesServed(socket, FRAME_LIMIT);

      expect((await overTheLimit(socket)).refusal).toMatchObject({ statusCode: 429 });

      // The connection's lookup, and one for each frame served.
      expect(auth.lookups).toHaveLength(1 + FRAME_LIMIT);
      expect(sessionGuardSaw).toHaveLength(FRAME_LIMIT);
      expect(getUserRoleGraph).toHaveBeenCalledTimes(FRAME_LIMIT);
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

  // Only `en` ships, so text renders in English whatever the locale. That the
  // handshake's locale reaches each translation is shown by the locale
  // `translate` is asked for.
  describe('the copy a client reads', () => {
    it("renders a validator's catalog marker as its text, not as the marker", async () => {
      const socket = await connected(socketAs(USER_A, 'marked'));
      const refused = refusalOf(socket);

      socket.emit('mark', { query: 42 });

      expect(await refused).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['query must be a string'],
        pattern: 'mark',
      });
    });

    // class-validator's own default reads the same, so the copy alone cannot
    // show the catalog rendered it. The lookup does.
    it("renders the search DTO's own catalog marker, before the handler runs", async () => {
      const translate = jest.spyOn(i18n, 'translate');
      const socket = await connected(socketAs(USER_A));
      const refused = refusalOf(socket);

      socket.emit(SearchEvents.SearchStart, searchStart({ correlationId: 'not-a-uuid' }));

      expect(await refused).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['correlationId must be a UUID'],
        pattern: SearchEvents.SearchStart,
        correlationId: 'not-a-uuid',
      });
      expect(translate).toHaveBeenCalledWith('validation.isUUID', expect.objectContaining({ lang: FALLBACK_LOCALE }));
      expect(queryLocalGames).not.toHaveBeenCalled();
      translate.mockRestore();
    });

    it("translates a frame's copy in the locale its handshake resolved, from its user and Accept-Language", async () => {
      const translate = jest.spyOn(i18n, 'translate');
      const socket = await connected(socketAs(USER_A, 'marked', 'fr-CA,fr;q=0.9'));
      const refused = refusalOf(socket);

      socket.emit('mark', { query: 42 });
      await refused;

      expect(resolveLocale).toHaveBeenCalledWith({ userId: USER_A, acceptLanguage: 'fr-CA,fr;q=0.9' });
      expect(translate).toHaveBeenCalledWith('validation.isString', expect.objectContaining({ lang: 'fr' }));
      translate.mockRestore();
    });

    it("tells a refused connection why in its handshake's Accept-Language", async () => {
      const translate = jest.spyOn(i18n, 'translate');
      const socket = io(`${baseUrl}/games/search`, {
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
        extraHeaders: { 'accept-language': 'fr' },
      });
      sockets.push(socket);

      const error = await new Promise<Error & { data?: unknown }>((resolve, reject) => {
        socket.once('connect_error', resolve);
        socket.once('connect', () => reject(new Error('The connection was accepted')));
      });

      expect(error.message).toBe('No token provided');
      expect(error.data).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'No token provided' });
      expect(translate).toHaveBeenCalledWith('errors.auth.no_token', expect.objectContaining({ lang: 'fr' }));
      translate.mockRestore();
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
