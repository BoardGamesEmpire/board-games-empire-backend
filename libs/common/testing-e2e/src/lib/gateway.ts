import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { afterAll, beforeAll } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { E2E_VERBOSE_VAR, launchOnFreePort, requireBundle, stopChild, WORKSPACE_ROOT } from './child-process.js';

/**
 * Launches a game gateway's built bundle and hands out a gRPC client for it,
 * shared by the gateway e2e apps. Everything here speaks the gateway's published proto over
 * a real channel; nothing imports gateway code.
 *
 * Shipped as `@bge/testing-e2e/gateway`, not from the package root: Jest
 * loads modules afresh for each spec file, and the `api-e2e` specs that import
 * the root have no use for the gRPC stack.
 */

const GATEWAY_HOST = '127.0.0.1';

const gatewayAddress = (port: number): string => `${GATEWAY_HOST}:${port}`;

/**
 * The `NODE_ENV` a gateway child runs under, the value CI runs the suites
 * with. Pinned rather than inherited because Jest's CLI assigns `test` when
 * the variable is unset, and `@bge/env` keys its `defaultsFor` maps on it.
 */
export const GATEWAY_NODE_ENV = 'testing';

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 250;
const CALL_DEADLINE_MS = 5_000;

/** Covers every port {@link launchOnFreePort} may try, each up to its readiness timeout. */
const LAUNCH_HOOK_TIMEOUT_MS = 120_000;

/** Covers {@link stopChild}'s SIGTERM grace and its SIGKILL fallback. */
const STOP_HOOK_TIMEOUT_MS = 30_000;

const GATEWAY_PROTO = path.join('bge', 'gateway', 'v1', 'gateway.proto');

export interface GatewayLaunch {
  /** The gateway's directory under `apps/`, which is also its Nx project name without the scope. */
  readonly app: string;

  /** How the gateway is named in log lines and failure messages. */
  readonly label: string;

  /** The variables the gateway's `main.ts` binds from (`hostEnv` / `portEnv`). */
  readonly hostEnv: string;
  readonly portEnv: string;

  /**
   * The child's environment, read when the launch starts, so it can name
   * something an earlier `beforeAll` started. The bind address and `NODE_ENV`
   * are added to it.
   */
  env(): NodeJS.ProcessEnv;
}

interface LaunchedGateway {
  readonly child: ChildProcess;

  /** `host:port`, ready for {@link connectGateway}. */
  readonly address: string;
}

/** Ping's reply as the client decodes it: int64 as a decimal string, enums by name. */
export interface GatewayPingReply {
  readonly correlationId: string;
  readonly timestampMs: string;
  readonly gatewayName: string;
  readonly gatewayVersion: string;
  readonly supportedServices: readonly string[];
  readonly languagePreferences: {
    readonly acceptedRequestFormats: readonly string[];
    readonly responseFormat: string;
    readonly passthroughRawLocale: boolean;
  } | null;
}

export interface GatewayLanguage {
  readonly value: string;
  readonly format: string;
  readonly ietfTag?: string;
  readonly iso6393?: string;
  readonly iso6391?: string;
  readonly name?: string;
  readonly nativeName?: string;
}

export interface GatewayLanguagesReply {
  readonly correlationId: string;
  readonly languages: readonly GatewayLanguage[];
}

export interface GatewayHealthReply {
  readonly status: string;
}

/** The gateway RPCs that answer without calling the gateway's upstream. */
export interface GatewayClient {
  ping(correlationId: string): Promise<GatewayPingReply>;
  check(): Promise<GatewayHealthReply>;
  listLanguages(correlationId: string): Promise<GatewayLanguagesReply>;
  close(): void;
}

type UnaryMethod = (
  request: object,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: unknown) => void,
) => grpc.ClientUnaryCall;

const gatewayDist = (app: string): string => path.join(WORKSPACE_ROOT, 'apps', app, 'dist');

const serviceConstructors = new Map<string, grpc.ServiceClientConstructor>();

/**
 * The `GatewayService` client constructor, loaded from the proto tree the
 * gateway's bundle serves (`dist/proto`, copied there at build), so client
 * and server read the same definition.
 */
function gatewayService(app: string): grpc.ServiceClientConstructor {
  const cached = serviceConstructors.get(app);
  if (cached) {
    return cached;
  }

  const definition = protoLoader.loadSync(GATEWAY_PROTO, {
    includeDirs: [path.join(gatewayDist(app), 'proto')],
    longs: String,
    enums: String,
    defaults: true,
    arrays: true,
  });

  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    readonly bge: { readonly gateway: { readonly v1: { readonly GatewayService: grpc.ServiceClientConstructor } } };
  };

  const constructor = loaded.bge.gateway.v1.GatewayService;
  serviceConstructors.set(app, constructor);

  return constructor;
}

/** A plaintext client for the gateway built from `app`, listening at `address`. */
function connectGateway(app: string, address: string): GatewayClient {
  const GatewayService = gatewayService(app);
  const client = new GatewayService(address, grpc.credentials.createInsecure());

  const call = <T>(method: string, request: object): Promise<T> =>
    new Promise((resolve, reject) => {
      const unary = client[method] as UnaryMethod;
      unary.call(client, request, { deadline: Date.now() + CALL_DEADLINE_MS }, (error, response) =>
        error ? reject(error) : resolve(response as T),
      );
    });

  return {
    ping: (correlationId) => call('Ping', { correlationId }),
    check: () => call('Check', { service: '' }),
    listLanguages: (correlationId) => call('ListLanguages', { correlationId }),
    close: () => client.close(),
  };
}

/**
 * True once the gateway answers `Check` with SERVING. A fresh client per probe,
 * so a channel left backing off by the probes before the server listened
 * cannot delay the one after.
 */
async function isServing(app: string, address: string): Promise<boolean> {
  const client = connectGateway(app, address);

  try {
    return (await client.check()).status === 'SERVING';
  } catch {
    // Not listening yet — keep polling.
    return false;
  } finally {
    client.close();
  }
}

/**
 * Launches a gateway's built bundle (`apps/<app>/dist/main.js`, from its
 * `build` target) on a free port, and resolves once it answers `Check` with
 * SERVING over gRPC.
 */
async function launchGateway(launch: GatewayLaunch): Promise<LaunchedGateway> {
  const { app, label, hostEnv, portEnv } = launch;

  const bundle = path.join(gatewayDist(app), 'main.js');
  requireBundle(label, bundle, `@boardgamesempire/${app}:build`);

  const env = launch.env();
  const { child, port } = await launchOnFreePort((port) => {
    const address = gatewayAddress(port);
    console.log(`[e2e] launching ${label} (${bundle}) on ${address}...`);

    return {
      label,
      bundle,
      env: { ...env, [hostEnv]: GATEWAY_HOST, [portEnv]: String(port), NODE_ENV: GATEWAY_NODE_ENV },
      verbose: env[E2E_VERBOSE_VAR] === 'true',
      isReady: () => isServing(app, address),
      timeoutMs: READINESS_TIMEOUT_MS,
      pollMs: READINESS_POLL_MS,
    };
  });

  return { child, address: gatewayAddress(port) };
}

/**
 * Runs a gateway for the spec file that calls it: launched in `beforeAll`,
 * stopped in `afterAll`. The returned function hands out a client connected
 * to it.
 *
 * Per file, from the spec, rather than once from global setup: Jest loads
 * global setup with Node's resolver, which cannot reach this module (see
 * `child-process.ts`). The cost is one gateway boot per file. As with
 * `useWorker` in `api-e2e`, there is no exit-hook fallback: a Jest process
 * that dies without running `afterAll` can orphan the gateway.
 */
export function useGateway(launch: GatewayLaunch): () => GatewayClient {
  let starting: Promise<LaunchedGateway> | undefined;
  let client: GatewayClient | undefined;

  beforeAll(async () => {
    starting = launchGateway(launch);
    const gateway = await starting;
    client = connectGateway(launch.app, gateway.address);
  }, LAUNCH_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    client?.close();
    client = undefined;

    const pending = starting;
    starting = undefined;

    // A launch that failed has already stopped its child, and `beforeAll`
    // reported why.
    const launched = await pending?.catch(() => undefined);
    await stopChild(launched?.child);
  }, STOP_HOOK_TIMEOUT_MS);

  return () => {
    if (client === undefined) {
      throw new Error(`The ${launch.label} is not running — useGateway() starts it in beforeAll`);
    }

    return client;
  };
}
