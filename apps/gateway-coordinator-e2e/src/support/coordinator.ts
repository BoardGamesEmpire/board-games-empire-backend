import type { Actor } from '@bge/actor-context';
import { BGE_ACTOR_HEADER, BGE_GATEWAY_ID_HEADER } from '@bge/shared';
import type { ChildLaunch } from '@bge/testing-e2e/child-process';
import {
  E2E_VERBOSE_VAR,
  launchChild,
  launchOnFreePort,
  requireBundle,
  stopChild,
  WORKSPACE_ROOT,
} from '@bge/testing-e2e/child-process';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { afterAll, beforeAll } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { COORDINATOR_NODE_ENV } from './e2e-env';
import { createTestDatabase } from './test-db';

/**
 * Launches the coordinator's built bundle and hands out gRPC clients for the
 * two protocols it serves (#1083): its own, which the api calls, and the
 * gateway's, which the gateway worker calls to reach the plugin DataGateways
 * the coordinator runs. Everything here speaks the published protos over a
 * real channel, as `@bge/testing-e2e/gateway` does for a remote DataGateway's
 * app.
 */

const COORDINATOR_HOST = '127.0.0.1';
const COORDINATOR_LABEL = 'Gateway coordinator';

const COORDINATOR_DIST = path.join(WORKSPACE_ROOT, 'apps', 'gateway-coordinator', 'dist');
const COORDINATOR_BUNDLE = path.join(COORDINATOR_DIST, 'main.js');

/**
 * The proto tree the coordinator's bundle serves, copied there at build. The
 * clients here load it, and so does the gateway worker's plugin driver source
 * when a spec runs one in the test process, so every side reads one
 * definition.
 */
export const COORDINATOR_PROTO_DIR = path.join(COORDINATOR_DIST, 'proto');

const COORDINATOR_PROTO = path.join('bge', 'coordinator', 'v1', 'coordinator.proto');
const GATEWAY_PROTO = path.join('bge', 'gateway', 'v1', 'gateway.proto');

const READINESS_TIMEOUT_MS = 45_000;
const READINESS_POLL_MS = 250;
const CALL_DEADLINE_MS = 15_000;

/** Covers every port {@link launchOnFreePort} may try, each up to its readiness timeout. */
const LAUNCH_HOOK_TIMEOUT_MS = 150_000;

/** Covers {@link stopChild}'s SIGTERM grace and its SIGKILL fallback. */
const STOP_HOOK_TIMEOUT_MS = 30_000;

/** How often a relaunch tries the port the coordinator had, and how long it waits between tries. */
const SAME_PORT_ATTEMPTS = 10;
const SAME_PORT_RETRY_MS = 500;

/**
 * The actor a call goes out as unless a spec names another. The coordinator
 * refuses a call that carries none.
 */
export const E2E_ACTOR: Actor = { kind: 'system', reason: 'gateway-coordinator-e2e' };

export interface CoordinatorLaunch {
  /**
   * The plugins root the coordinator reads, asked for when a launch starts,
   * so it can name a directory an earlier `beforeAll` made and filled.
   */
  pluginsRoot(): string;
}

/** A game as a search result carries it, as the client decodes it. */
export interface SearchedGame {
  readonly externalId: string;
  readonly title: string;
}

/** One frame of the coordinator's SearchGames stream: enums by name. */
export interface CoordinatorSearchFrame {
  readonly correlationId: string;
  readonly game?: SearchedGame;
  readonly gatewayId: string;
  readonly message?: string;
  readonly status: string;
}

/** The coordinator's FetchGame reply. */
export interface CoordinatorFetchReply {
  readonly correlationId: string;
  readonly game?: SearchedGame;
  readonly gatewayId: string;
  readonly message?: string;
  readonly status: string;
}

/** ConnectGateway's and ReinterviewGateway's reply. An unset optional field is absent. */
export interface GatewayAdminReply {
  readonly error?: string;
  readonly refusalReason?: string;
  readonly success: boolean;
}

export interface ConnectGatewayCall {
  readonly authType: string;
  readonly connectionPort: number;
  readonly connectionUrl: string;
  readonly gatewayId: string;
}

/** The coordinator's own protocol, `bge.coordinator.v1`, as the api calls it. */
export interface CoordinatorClient {
  check(): Promise<{ readonly status: string }>;

  connectGateway(call: ConnectGatewayCall): Promise<GatewayAdminReply>;
  fetchGame(gatewayId: string, externalId: string, actor?: Actor): Promise<CoordinatorFetchReply>;
  reinterviewGateway(gatewayId: string): Promise<GatewayAdminReply>;
  /** Every frame of a search that names `gatewayId`. `query` keys the coordinator's search cache. */
  searchGames(gatewayId: string, query: string, actor?: Actor): Promise<CoordinatorSearchFrame[]>;
}

/** One frame of a DataGateway's SearchGames stream: enums by name. */
export interface GatewaySearchFrame {
  readonly correlationId: string;
  readonly game?: SearchedGame;
  readonly message?: string;
  readonly status: string;
}

export interface GatewayFetchReply {
  readonly correlationId: string;
  readonly game?: SearchedGame;
  readonly message?: string;
  readonly status: string;
}

/** Ping's reply as the client decodes it: int64 as a decimal string. */
export interface GatewayPingReply {
  readonly correlationId: string;
  readonly gatewayName: string;
  readonly gatewayVersion: string;
  readonly timestampMs: string;
}

/**
 * The gateway protocol, `bge.gateway.v1`, as the coordinator serves it for
 * its plugin DataGateways. Every call of one client carries the same
 * metadata.
 */
export interface PluginGatewayClient {
  fetchGame(externalId: string): Promise<GatewayFetchReply>;
  ping(): Promise<GatewayPingReply>;
  searchGames(query: string): Promise<GatewaySearchFrame[]>;
}

/** What a gateway protocol client's calls carry in their metadata. */
export interface GatewayCallMetadata {
  /** The actor the calls go out as, under `x-bge-actor`: {@link E2E_ACTOR} unless set, and none when null. */
  readonly actor?: Actor | null;

  /** The plugin DataGateway the calls are for, under `x-bge-gateway-id`. Left out, the calls name none. */
  readonly gatewayId?: string;
}

export interface RunningCoordinator {
  gateway(metadata?: GatewayCallMetadata): PluginGatewayClient;

  readonly host: string;

  /** The port it listens on, which it keeps across {@link restart}. */
  readonly port: number;
  /**
   * Stops it if it runs, and launches it again on the same port, over the
   * plugin rows and the plugins root as they are now. A client or a driver
   * built before the restart reaches the new process at the address it has.
   */
  restart(): Promise<void>;

  readonly service: CoordinatorClient;

  /** Stops it as a deployment does, with SIGTERM, so its shutdown hooks run. */
  stop(): Promise<void>;
}

/** A client of one service, as its constructor builds it: its RPCs are reached by name. */
type ServiceClient = InstanceType<grpc.ServiceClientConstructor>;

type UnaryMethod = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: unknown) => void,
) => grpc.ClientUnaryCall;

type ServerStreamMethod = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
) => grpc.ClientReadableStream<unknown>;

interface ServiceConstructors {
  readonly CoordinatorService: grpc.ServiceClientConstructor;
  readonly GatewayService: grpc.ServiceClientConstructor;
}

let constructors: ServiceConstructors | undefined;

/** Both services' client constructors, loaded from the proto tree the bundle serves. */
function serviceConstructors(): ServiceConstructors {
  if (constructors) {
    return constructors;
  }

  const definition = protoLoader.loadSync([COORDINATOR_PROTO, GATEWAY_PROTO], {
    includeDirs: [COORDINATOR_PROTO_DIR],
    longs: String,
    enums: String,
    defaults: true,
    arrays: true,
  });

  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    readonly bge: {
      readonly coordinator: { readonly v1: { readonly CoordinatorService: grpc.ServiceClientConstructor } };
      readonly gateway: { readonly v1: { readonly GatewayService: grpc.ServiceClientConstructor } };
    };
  };

  constructors = {
    CoordinatorService: loaded.bge.coordinator.v1.CoordinatorService,
    GatewayService: loaded.bge.gateway.v1.GatewayService,
  };

  return constructors;
}

const callOptions = (): grpc.CallOptions => ({ deadline: Date.now() + CALL_DEADLINE_MS });

/** The metadata a call carries: the actor as the coordinator decodes it, and the DataGateway it names, each if any. */
function callMetadata(actor: Actor | null, gatewayId?: string): grpc.Metadata {
  const metadata = new grpc.Metadata();

  if (actor !== null) {
    metadata.set(BGE_ACTOR_HEADER, Buffer.from(JSON.stringify(actor), 'utf8').toString('base64'));
  }

  if (gatewayId !== undefined) {
    metadata.set(BGE_GATEWAY_ID_HEADER, gatewayId);
  }

  return metadata;
}

function unary<T>(client: ServiceClient, method: string, request: object, metadata: grpc.Metadata): Promise<T> {
  return new Promise((resolve, reject) => {
    const call = client[method] as UnaryMethod;
    call.call(client, request, metadata, callOptions(), (error, response) =>
      error ? reject(error) : resolve(response as T),
    );
  });
}

/** Every frame of a server stream, or the error that ended it. */
function serverStream<T>(
  client: ServiceClient,
  method: string,
  request: object,
  metadata: grpc.Metadata,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const call = client[method] as ServerStreamMethod;
    const stream = call.call(client, request, metadata, callOptions());
    const frames: T[] = [];

    stream.on('data', (frame: T) => frames.push(frame));
    stream.on('error', reject);
    stream.on('end', () => resolve(frames));
  });
}

function coordinatorClient(client: ServiceClient): CoordinatorClient {
  return {
    // Check carries no actor: a health probe has none, and the coordinator exempts it.
    check: () => unary(client, 'Check', { service: '' }, new grpc.Metadata()),
    searchGames: (gatewayId, query, actor = E2E_ACTOR) =>
      serverStream(
        client,
        'SearchGames',
        { correlationId: randomUUID(), query, gatewayIds: [gatewayId] },
        callMetadata(actor),
      ),
    fetchGame: (gatewayId, externalId, actor = E2E_ACTOR) =>
      unary(client, 'FetchGame', { correlationId: randomUUID(), gatewayId, externalId }, callMetadata(actor)),
    reinterviewGateway: (gatewayId) => unary(client, 'ReinterviewGateway', { gatewayId }, callMetadata(E2E_ACTOR)),
    connectGateway: (call) => unary(client, 'ConnectGateway', call, callMetadata(E2E_ACTOR)),
  };
}

function pluginGatewayClient(
  client: ServiceClient,
  { gatewayId, actor = E2E_ACTOR }: GatewayCallMetadata,
): PluginGatewayClient {
  const metadata = (): grpc.Metadata => callMetadata(actor, gatewayId);

  return {
    ping: () => unary(client, 'Ping', { correlationId: randomUUID() }, metadata()),
    searchGames: (query) => serverStream(client, 'SearchGames', { correlationId: randomUUID(), query }, metadata()),
    fetchGame: (externalId) => unary(client, 'FetchGame', { correlationId: randomUUID(), externalId }, metadata()),
  };
}

const coordinatorAddress = (port: number): string => `${COORDINATOR_HOST}:${port}`;

/**
 * True once the coordinator answers `Check` with SERVING. It listens only
 * after its boot hooks have run, the plugin loader's among them, so a
 * coordinator that is serving has loaded, or quarantined, every plugin it was
 * going to. A fresh client per probe, so a channel left backing off by the
 * probes before the server listened cannot delay the one after.
 */
async function isServing(address: string): Promise<boolean> {
  const { CoordinatorService } = serviceConstructors();
  const client = new CoordinatorService(address, grpc.credentials.createInsecure());

  try {
    return (await coordinatorClient(client).check()).status === 'SERVING';
  } catch {
    // Not listening yet: keep polling.
    return false;
  } finally {
    client.close();
  }
}

/**
 * Whether the coordinator has finished its boot: it answers, and every
 * plugin it loaded says so in its load record. It marks the records ready
 * only once its gRPC server listens (#1083), so an answer alone can come a
 * moment before a spec could read them. A plugin whose load failed is
 * quarantined, disabled, and its record never says ready, so it isn't
 * waited for.
 */
async function hasBooted(address: string): Promise<boolean> {
  if (!(await isServing(address))) {
    return false;
  }

  const database = createTestDatabase();

  try {
    const waiting = await database.client.pluginProcessLoad.findMany({
      where: { processRole: 'coordinator', ready: false },
      select: { slug: true },
    });

    if (waiting.length === 0) {
      return true;
    }

    const loading = await database.client.plugin.count({
      where: { slug: { in: waiting.map(({ slug }) => slug) }, enabled: true, loadFailed: false },
    });

    return loading === 0;
  } finally {
    await database.close();
  }
}

/** The launch of the bundle on `port`, over the environment as it is now. */
function childLaunch(launch: CoordinatorLaunch, port: number): ChildLaunch {
  const address = coordinatorAddress(port);
  console.log(`[e2e] launching ${COORDINATOR_LABEL} (${COORDINATOR_BUNDLE}) on ${address}...`);

  return {
    label: COORDINATOR_LABEL,
    bundle: COORDINATOR_BUNDLE,
    env: {
      ...process.env,
      COORDINATOR_GRPC_HOST: COORDINATOR_HOST,
      COORDINATOR_GRPC_PORT: String(port),
      PLUGINS_ROOT: launch.pluginsRoot(),
      NODE_ENV: COORDINATOR_NODE_ENV,
      // `global-setup` sets it for the Prisma CLI. A server gives it to the
      // api alone, so the coordinator would warn that it holds one.
      DATABASE_MIGRATION_URL: '',
    },
    verbose: process.env[E2E_VERBOSE_VAR] === 'true',
    isReady: () => hasBooted(address),
    timeoutMs: READINESS_TIMEOUT_MS,
    pollMs: READINESS_POLL_MS,
  };
}

/**
 * Launches the bundle again on the port it had. `launchOnFreePort` would
 * pick a new one, and what was built before the restart, a gRPC client or
 * the gateway worker's driver, dials the old address. The port can still be
 * held for a moment after the old process exits, so a lost bind is tried
 * again.
 */
async function launchOnSamePort(launch: CoordinatorLaunch, port: number): Promise<ChildProcess> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await launchChild(childLaunch(launch, port));

    if (outcome.kind === 'ready') {
      return outcome.child;
    }

    const portStillHeld = outcome.kind === 'exited' && outcome.outputTail.some((line) => line.includes('EADDRINUSE'));
    if (!portStillHeld || attempt >= SAME_PORT_ATTEMPTS) {
      throw new Error(outcome.failure);
    }

    await delay(SAME_PORT_RETRY_MS);
  }
}

/**
 * Runs a coordinator for the spec file that calls it: launched in
 * `beforeAll`, on a free port, and stopped in `afterAll`. The returned
 * function hands out the running coordinator.
 *
 * Per file, from the spec, because what a coordinator loads is decided when
 * it boots: the spec file seeds its plugin rows and fills its plugins root in
 * a `beforeAll` registered before this one. As with `useGateway`, there is no
 * exit-hook fallback: a Jest process that dies without running `afterAll`
 * can orphan the coordinator.
 */
export function useCoordinator(launch: CoordinatorLaunch): () => RunningCoordinator {
  let child: ChildProcess | undefined;
  let running: RunningCoordinator | undefined;
  const clients: ServiceClient[] = [];

  const stop = async (): Promise<void> => {
    const stopping = child;
    child = undefined;
    await stopChild(stopping);
  };

  beforeAll(async () => {
    requireBundle(COORDINATOR_LABEL, COORDINATOR_BUNDLE, '@boardgamesempire/gateway-coordinator:build');

    const launched = await launchOnFreePort((port) => childLaunch(launch, port));
    child = launched.child;

    const { port } = launched;
    const address = coordinatorAddress(port);
    const { CoordinatorService, GatewayService } = serviceConstructors();
    const coordinator = new CoordinatorService(address, grpc.credentials.createInsecure());
    const gateway = new GatewayService(address, grpc.credentials.createInsecure());
    clients.push(coordinator, gateway);

    running = {
      host: COORDINATOR_HOST,
      port,
      service: coordinatorClient(coordinator),
      gateway: (metadata = {}) => pluginGatewayClient(gateway, metadata),
      stop,
      restart: async () => {
        await stop();
        child = await launchOnSamePort(launch, port);
      },
    };
  }, LAUNCH_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }

    running = undefined;
    await stop();
  }, STOP_HOOK_TIMEOUT_MS);

  return () => {
    if (running === undefined) {
      throw new Error(`The ${COORDINATOR_LABEL} is not running: useCoordinator() starts it in beforeAll`);
    }

    return running;
  };
}
