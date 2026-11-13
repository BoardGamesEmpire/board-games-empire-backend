import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import type * as proto from '@boardgamesempire/proto-gateway';
import { GatewayServiceControllerMethods } from '@boardgamesempire/proto-gateway';
import { Controller, Inject, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { catchError, throwError, type Observable } from 'rxjs';
import { DATA_GATEWAY_DRIVER } from './data-gateway-driver.token';

/** gRPC's statuses for a failed call, CANCELLED (1) to UNAUTHENTICATED (16). */
const isGrpcErrorStatus = (code: unknown): code is number =>
  Number.isInteger(code) && Number(code) >= 1 && Number(code) <= 16;

/**
 * An error a driver raised with the gRPC status it stands for, such as
 * UNIMPLEMENTED. A DOMException carries a numeric code of its own, which
 * isn't a status: an aborted fetch's AbortError has 20 (#1082).
 */
const hasGrpcStatus = (err: unknown): err is Error & { code: number } =>
  err instanceof Error && !(err instanceof DOMException) && isGrpcErrorStatus((err as { code?: unknown }).code);

/**
 * The gRPC controller every remote DataGateway's app serves. It logs each
 * RPC and hands it to the injected DataGatewayDriver, so a remote
 * DataGateway's app and the server, when it serves a plugin DataGateway
 * (#1083), run the same driver code (#1082). All upstream-specific behavior
 * lives in the driver.
 */
@GatewayServiceControllerMethods()
@Controller()
export class DataGatewayController implements proto.GatewayServiceController, OnApplicationShutdown {
  private readonly logger = new Logger(DataGatewayController.name);

  constructor(@Inject(DATA_GATEWAY_DRIVER) private readonly driver: DataGatewayDriver) {}

  ping(request: proto.GatewayPingRequest): Observable<proto.GatewayPingResponse> {
    this.logger.log('Ping request received');
    return this.relay(this.driver.ping(request));
  }

  check(request: proto.HealthCheckRequest): Observable<proto.HealthCheckResponse> {
    return this.relay(this.driver.check(request));
  }

  describe(request: proto.DescribeRequest): Observable<proto.DescribeResponse> {
    this.logger.log('Describe request received');
    return this.relay(this.driver.describe(request));
  }

  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    this.logger.log(`SearchGames request received with query: '${request.query}'`);
    return this.relay(this.driver.searchGames(request));
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    this.logger.log(`FetchGame request received for externalId: '${request.externalId}'`);
    return this.relay(this.driver.fetchGame(request));
  }

  fetchGames(request: proto.FetchGamesRequest): Observable<proto.FetchGamesResponse> {
    this.logger.log(`FetchGames request received for ${request.externalIds.length} external IDs`);
    return this.relay(this.driver.fetchGames(request));
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    this.logger.log(`FetchExpansions request received for baseExternalId: '${request.baseExternalId}'`);
    return this.relay(this.driver.fetchExpansions(request));
  }

  listLanguages(request: proto.ListLanguagesRequest): Observable<proto.ListLanguagesResponse> {
    this.logger.log('ListLanguages request received');
    return this.relay(this.driver.listLanguages(request));
  }

  listPlatforms(request: proto.ListPlatformsRequest): Observable<proto.ListPlatformsResponse> {
    this.logger.log('ListPlatforms request received');
    return this.relay(this.driver.listPlatforms(request));
  }

  listCategories(request: proto.ListCategoriesRequest): Observable<proto.ListCategoriesResponse> {
    this.logger.log('ListCategories request received');
    return this.relay(this.driver.listCategories(request));
  }

  listMechanics(request: proto.ListMechanicsRequest): Observable<proto.ListMechanicsResponse> {
    this.logger.log('ListMechanics request received');
    return this.relay(this.driver.listMechanics(request));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.driver.dispose();
  }

  /**
   * The driver's answer, with an error that carries a gRPC status code sent
   * as that status. A driver can't depend on Nest, so it raises a plain
   * error with the code (`unsupportedOperation`), and this turns it into the
   * RpcException Nest's gRPC server reads the status from. Any other error
   * passes through as it is (#1082).
   */
  private relay<T>(answer: Observable<T>): Observable<T> {
    return answer.pipe(
      catchError((err: unknown) =>
        throwError(() => (hasGrpcStatus(err) ? new RpcException({ code: err.code, message: err.message }) : err)),
      ),
    );
  }
}
