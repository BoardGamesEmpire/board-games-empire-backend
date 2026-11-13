import { unsupportedOperation, type DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import * as proto from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { firstValueFrom, lastValueFrom, Observable, of, throwError, toArray } from 'rxjs';
import { DATA_GATEWAY_DRIVER } from './data-gateway-driver.token';
import { DataGatewayController } from './data-gateway.controller';

type Rpc = Exclude<keyof DataGatewayDriver, 'dispose' | 'handleInbound'>;

/** Each RPC with a request the controller is handed and the frames its driver answers with. */
const RPCS: ReadonlyArray<[Rpc, object, object[]]> = [
  [
    'ping',
    { correlationId: 'c' },
    [{ correlationId: 'c', timestampMs: 0n, gatewayName: 'TestGateway', gatewayVersion: '1.0.0' }],
  ],
  ['check', { service: '' }, [{ status: proto.HealthCheckResponse_ServingStatus.SERVING }]],
  ['describe', { correlationId: 'c' }, [{ correlationId: 'c', capabilities: [] }]],
  [
    'searchGames',
    { correlationId: 'c', query: 'catan' },
    [
      { correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_RESULT },
      { correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE },
    ],
  ],
  ['fetchGame', { correlationId: 'c', externalId: '13' }, [{ correlationId: 'c', status: 'RESULT_STATUS_ERROR' }]],
  [
    'fetchGames',
    { correlationId: 'c', externalIds: ['13', '822'] },
    [
      { correlationId: 'c', externalId: '13', status: proto.ResultStatus.RESULT_STATUS_RESULT },
      { correlationId: 'c', externalId: '822', status: proto.ResultStatus.RESULT_STATUS_RATE_LIMITED },
    ],
  ],
  [
    'fetchExpansions',
    { correlationId: 'c', baseExternalId: '13' },
    [
      { correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_RESULT },
      { correlationId: 'c', status: proto.ResultStatus.RESULT_STATUS_SOURCE_DONE },
    ],
  ],
  ['listLanguages', { correlationId: 'c' }, [{ correlationId: 'c', languages: [] }]],
  ['listPlatforms', { correlationId: 'c' }, [{ correlationId: 'c', platforms: [] }]],
  ['listCategories', { correlationId: 'c' }, [{ correlationId: 'c', categories: [] }]],
  ['listMechanics', { correlationId: 'c' }, [{ correlationId: 'c', mechanics: [] }]],
];

/**
 * The gRPC controller every remote DataGateway's app serves, and the server
 * too when it serves a plugin DataGateway (#1083): it hands each RPC to the
 * driver it was given, so both run the same code (#1082).
 */
describe('DataGatewayController', () => {
  let controller: DataGatewayController;
  let driver: jest.Mocked<DataGatewayDriver>;

  /** Calls `rpc` on the controller as the gRPC server does, its answer as frames. */
  const answer = (rpc: Rpc, request: object) =>
    (controller[rpc] as (request: object) => Observable<unknown>).call(controller, request);

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

    const module = await Test.createTestingModule({
      controllers: [DataGatewayController],
      providers: [{ provide: DATA_GATEWAY_DRIVER, useValue: driver }],
    }).compile();

    controller = module.get(DataGatewayController);
  });

  it.each(RPCS)(
    'hands %s to the driver with the request it was given, and sends its frames',
    async (rpc, request, frames) => {
      (driver[rpc] as jest.Mock).mockReturnValue(of(...frames));

      await expect(lastValueFrom(answer(rpc, request).pipe(toArray()))).resolves.toEqual(frames);
      expect(driver[rpc]).toHaveBeenCalledWith(request);
    },
  );

  // A driver can't depend on Nest, so it says which gRPC status a failure is
  // with a code on the error, and the controller passes it on as that status
  // (#1082).
  it("sends a driver's error that carries a gRPC status code as that status", async () => {
    driver.listMechanics.mockReturnValue(unsupportedOperation('ListMechanics'));

    const refusal = await firstValueFrom(answer('listMechanics', {})).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(RpcException);
    expect((refusal as RpcException).getError()).toEqual({
      code: status.UNIMPLEMENTED,
      message: 'ListMechanics is not served by this DataGateway',
    });
  });

  it('passes an error with no gRPC status code through unchanged', async () => {
    const failure = new Error('upstream exploded');
    const systemFailure = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    driver.fetchGame.mockReturnValueOnce(throwError(() => failure));
    driver.searchGames.mockReturnValueOnce(throwError(() => systemFailure));

    await expect(firstValueFrom(answer('fetchGame', {}))).rejects.toBe(failure);
    await expect(firstValueFrom(answer('searchGames', {}))).rejects.toBe(systemFailure);
  });

  // A DOMException carries a legacy numeric code of its own (AbortError's is
  // 20), which isn't a gRPC status, so it isn't sent as one (#1082).
  it('passes a DOMException through unchanged, though it carries a numeric code', async () => {
    const aborted = new DOMException('The operation was aborted.', 'AbortError');
    const notAStatus = Object.assign(new Error('teapot'), { code: 418 });
    driver.listPlatforms.mockReturnValueOnce(throwError(() => aborted));
    driver.listCategories.mockReturnValueOnce(throwError(() => notAStatus));

    await expect(firstValueFrom(answer('listPlatforms', {}))).rejects.toBe(aborted);
    await expect(firstValueFrom(answer('listCategories', {}))).rejects.toBe(notAStatus);
  });

  it('disposes of the driver once when the app shuts down', async () => {
    await controller.onApplicationShutdown();

    expect(driver.dispose).toHaveBeenCalledTimes(1);
  });
});
