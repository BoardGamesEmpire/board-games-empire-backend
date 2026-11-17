import { DataGatewayCapability } from '@bge/database';
import type { GatewayRefusalReason } from '@bge/gateway-registry';
import { GatewayRegistryService, GatewayRoutingRefusedError } from '@bge/gateway-registry';
import { BGE_GATEWAY_ID_HEADER } from '@bge/shared';
import type { DataGatewayDriver, DataGatewayDriverOperation } from '@boardgamesempire/gateway-driver-contract';
import { unsupportedOperation } from '@boardgamesempire/gateway-driver-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import { Metadata, status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Observable } from 'rxjs';
import { lastValueFrom, of, throwError, toArray } from 'rxjs';
import { PluginGatewayController } from './plugin-gateway.controller';

/** The plugin DataGateway the calls name. */
const GW = 'acme';

const { Search, Fetch, FetchGames, FetchExpansions, ListLanguages, ListPlatforms, ListCategories, ListMechanics } =
  DataGatewayCapability;

/**
 * Each RPC with the capability its DataGateway must be routable for, none
 * for a call that names no operation the row declares, a request the
 * controller is handed, and the frames its driver answers with.
 */
const RPCS: ReadonlyArray<[DataGatewayDriverOperation, DataGatewayCapability | undefined, object, object[]]> = [
  [
    'ping',
    undefined,
    { correlationId: 'c' },
    [{ correlationId: 'c', timestampMs: 0n, gatewayName: 'Acme Games', gatewayVersion: '1.0.0' }],
  ],
  ['check', undefined, { service: '' }, [{ status: proto.HealthCheckResponse_ServingStatus.SERVING }]],
  ['describe', undefined, { correlationId: 'c' }, [{ correlationId: 'c', capabilities: [] }]],
  [
    'searchGames',
    Search,
    { correlationId: 'c', query: 'catan' },
    [
      { correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_RESULT },
      { correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE },
    ],
  ],
  [
    'fetchGame',
    Fetch,
    { correlationId: 'c', externalId: '13' },
    [{ correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_RESULT }],
  ],
  [
    'fetchGames',
    FetchGames,
    { correlationId: 'c', externalIds: ['13', '822'] },
    [
      { correlationId: 'c', externalId: '13', status: proto.ResultStatus.RESULT_STATUS_RESULT },
      { correlationId: 'c', externalId: '822', status: proto.ResultStatus.RESULT_STATUS_RATE_LIMITED },
    ],
  ],
  [
    'fetchExpansions',
    FetchExpansions,
    { correlationId: 'c', baseExternalId: '13' },
    [{ correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_RESULT }],
  ],
  ['listLanguages', ListLanguages, { correlationId: 'c' }, [{ correlationId: 'c', languages: [] }]],
  ['listPlatforms', ListPlatforms, { correlationId: 'c' }, [{ correlationId: 'c', platforms: [] }]],
  ['listCategories', ListCategories, { correlationId: 'c' }, [{ correlationId: 'c', categories: [] }]],
  ['listMechanics', ListMechanics, { correlationId: 'c' }, [{ correlationId: 'c', mechanics: [] }]],
];

/** A call's metadata, naming `gatewayId` as the DataGateway it is for when one is given. */
const metadataNaming = (gatewayId?: string): Metadata => {
  const metadata = new Metadata();

  if (gatewayId !== undefined) {
    metadata.set(BGE_GATEWAY_ID_HEADER, gatewayId);
  }

  return metadata;
};

/** What a call failed with. A call that answers instead fails the test. */
const rejection = (answered: Observable<unknown>): Promise<unknown> =>
  lastValueFrom(answered).then(
    () => {
      throw new Error('The call answered, where a failure was expected');
    },
    (err: unknown) => err,
  );

/**
 * The coordinator's side of the gateway gRPC protocol: the gateway worker
 * reaches a plugin DataGateway through it, naming the DataGateway in the
 * call's metadata, and the coordinator answers from that plugin's driver
 * (#1083).
 */
describe('PluginGatewayController', () => {
  let module: TestingModule;
  let controller: PluginGatewayController;
  let registry: { pluginDriver: jest.Mock };
  let driver: jest.Mocked<DataGatewayDriver>;

  /**
   * Calls `rpc` on the controller as Nest's gRPC server does: the request,
   * then the call's metadata, which names the DataGateway unless the case
   * says what the call carries instead.
   */
  const answer = (
    rpc: DataGatewayDriverOperation,
    request: object,
    carrying: { metadata?: Metadata } = { metadata: metadataNaming(GW) },
  ): Observable<unknown> =>
    (controller[rpc] as (request: object, metadata?: Metadata) => Observable<unknown>).call(
      controller,
      request,
      carrying.metadata,
    );

  beforeEach(async () => {
    driver = {
      ping: jest.fn(),
      check: jest.fn(),
      describe: jest.fn(),
      searchGames: jest.fn(),
      fetchGame: jest.fn(),
      fetchGames: jest.fn(),
      fetchExpansions: jest.fn(),
      listLanguages: jest.fn(),
      listPlatforms: jest.fn(),
      listCategories: jest.fn(),
      listMechanics: jest.fn(),
      dispose: jest.fn(),
    };
    registry = { pluginDriver: jest.fn().mockResolvedValue(driver) };

    module = await Test.createTestingModule({
      controllers: [PluginGatewayController],
      providers: [{ provide: GatewayRegistryService, useValue: registry }],
    }).compile();

    controller = module.get(PluginGatewayController);
  });

  it.each(RPCS)(
    'answers %s from the driver of the DataGateway the call names, routed for the capability the operation needs (#1083)',
    async (rpc, capability, request, frames) => {
      (driver[rpc] as jest.Mock).mockReturnValue(of(...frames));

      await expect(lastValueFrom(answer(rpc, request).pipe(toArray()))).resolves.toEqual(frames);

      expect(registry.pluginDriver).toHaveBeenCalledTimes(1);
      expect(registry.pluginDriver).toHaveBeenCalledWith(GW, capability);
      expect(driver[rpc]).toHaveBeenCalledTimes(1);
      expect(driver[rpc]).toHaveBeenCalledWith(request);
    },
  );

  // Without the id nothing says whose driver should answer, so no driver is
  // asked for, and none is built to find out.
  it('refuses a call with no DataGateway id (#1083)', async () => {
    const calls: Record<string, { metadata?: Metadata }> = {
      'metadata that names none': { metadata: metadataNaming() },
      'an empty id': { metadata: metadataNaming('') },
      'no metadata at all': {},
    };

    for (const [what, carrying] of Object.entries(calls)) {
      const refusal = await rejection(answer('ping', { correlationId: 'c' }, carrying));

      expect({ what, refusal }).toEqual({ what, refusal: expect.any(RpcException) });
      expect((refusal as RpcException).getError()).toEqual({
        code: status.INVALID_ARGUMENT,
        message: "The call names no DataGateway: its metadata needs 'x-bge-gateway-id'",
      });
    }

    expect(registry.pluginDriver).not.toHaveBeenCalled();
  });

  it("answers FAILED_PRECONDITION when the plugin isn't loaded (#1083)", async () => {
    registry.pluginDriver.mockRejectedValue(new GatewayRoutingRefusedError(GW, 'plugin_not_loaded'));

    const refusal = await rejection(answer('searchGames', { correlationId: 'c', query: 'catan' }));

    expect(refusal).toBeInstanceOf(RpcException);
    expect((refusal as RpcException).getError()).toEqual({
      code: status.FAILED_PRECONDITION,
      message: "DataGateway acme's plugin isn't loaded: restart the coordinator",
    });
    expect(driver.searchGames).not.toHaveBeenCalled();
  });

  // To whoever names it, a DataGateway the registry doesn't know isn't there:
  // one that was deleted, never existed, or is a remote DataGateway. Every
  // other refusal is of a DataGateway that exists and may not serve the call
  // as things stand, which a retry alone won't change.
  it.each<[GatewayRefusalReason, number, string]>([
    ['unknown', status.NOT_FOUND, "DataGateway acme doesn't exist, or was deleted"],
    ['disabled', status.FAILED_PRECONDITION, 'DataGateway acme is disabled'],
    [
      'plugin_not_served',
      status.FAILED_PRECONDITION,
      "DataGateway acme's plugin is disabled, uninstalled, failed to load or is no longer a data-gateway plugin",
    ],
    ['not_interviewed', status.FAILED_PRECONDITION, "DataGateway acme hasn't passed its first interview"],
    ['not_declared', status.FAILED_PRECONDITION, "DataGateway acme doesn't declare Fetch"],
    ['switched_off', status.FAILED_PRECONDITION, 'An admin switched Fetch off for DataGateway acme'],
  ])(
    "answers the gateway registry's refusal %s as status %d, with the refusal's words (#1083)",
    async (reason, code, message) => {
      registry.pluginDriver.mockRejectedValue(new GatewayRoutingRefusedError(GW, reason, Fetch));

      const refusal = await rejection(answer('fetchGame', { correlationId: 'c', externalId: '13' }));

      expect(refusal).toBeInstanceOf(RpcException);
      expect((refusal as RpcException).getError()).toEqual({ code, message });
    },
  );

  // A driver can't depend on Nest, so it says which gRPC status a failure is
  // with a code on the error (#1082). The gateway worker reads the same
  // status from a plugin DataGateway as from a remote one.
  it("relays a driver's UNIMPLEMENTED as that status (#1083)", async () => {
    driver.listMechanics.mockReturnValue(unsupportedOperation('ListMechanics'));

    const refusal = await rejection(answer('listMechanics', { correlationId: 'c' }));

    expect(refusal).toBeInstanceOf(RpcException);
    expect((refusal as RpcException).getError()).toEqual({
      code: status.UNIMPLEMENTED,
      message: 'ListMechanics is not served by this DataGateway',
    });
  });

  it("passes on any other failure as it is: the driver's, and one of building the driver (#1083)", async () => {
    const upstreamDown = new Error('The upstream is down');
    driver.fetchGame.mockReturnValue(throwError(() => upstreamDown));

    await expect(rejection(answer('fetchGame', { correlationId: 'c', externalId: '13' }))).resolves.toBe(upstreamDown);

    const buildFailed = new Error("Plugin 'acme-games' did not provide a DataGateway driver the server can use.");
    registry.pluginDriver.mockRejectedValue(buildFailed);

    await expect(rejection(answer('fetchGame', { correlationId: 'c', externalId: '13' }))).resolves.toBe(buildFailed);
  });

  // The gateway registry owns every driver it hands out, and disposes them at
  // shutdown. The controller a remote DataGateway's app serves disposes its
  // one driver itself; a second dispose from here would race the registry's.
  it('disposes no driver it answered from when the app shuts down (#1083)', async () => {
    driver.ping.mockReturnValue(of({ correlationId: 'c' } as proto.GatewayPingResponse));
    await module.init();
    await lastValueFrom(answer('ping', { correlationId: 'c' }));

    await module.close();

    expect(driver.dispose).not.toHaveBeenCalled();
  });
});
