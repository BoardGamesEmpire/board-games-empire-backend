import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import type * as proto from '@boardgamesempire/proto-gateway';
import { GatewayServiceControllerMethods } from '@boardgamesempire/proto-gateway';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Controller, Inject, Logger } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { DATA_GATEWAY_DRIVER } from './data-gateway-driver.token';
import { relayDriverAnswer } from './relay-driver-answer';

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
    return relayDriverAnswer(this.driver.ping(request));
  }

  check(request: proto.HealthCheckRequest): Observable<proto.HealthCheckResponse> {
    return relayDriverAnswer(this.driver.check(request));
  }

  describe(request: proto.DescribeRequest): Observable<proto.DescribeResponse> {
    this.logger.log('Describe request received');
    return relayDriverAnswer(this.driver.describe(request));
  }

  searchGames(request: proto.GatewaySearchRequest): Observable<proto.GatewaySearchResult> {
    this.logger.log(`SearchGames request received with query: '${request.query}'`);
    return relayDriverAnswer(this.driver.searchGames(request));
  }

  fetchGame(request: proto.FetchGameRequest): Observable<proto.FetchGameResponse> {
    this.logger.log(`FetchGame request received for externalId: '${request.externalId}'`);
    return relayDriverAnswer(this.driver.fetchGame(request));
  }

  fetchGames(request: proto.FetchGamesRequest): Observable<proto.FetchGamesResponse> {
    this.logger.log(`FetchGames request received for ${request.externalIds.length} external IDs`);
    return relayDriverAnswer(this.driver.fetchGames(request));
  }

  fetchExpansions(request: proto.FetchExpansionsRequest): Observable<proto.GatewaySearchResult> {
    this.logger.log(`FetchExpansions request received for baseExternalId: '${request.baseExternalId}'`);
    return relayDriverAnswer(this.driver.fetchExpansions(request));
  }

  listLanguages(request: proto.ListLanguagesRequest): Observable<proto.ListLanguagesResponse> {
    this.logger.log('ListLanguages request received');
    return relayDriverAnswer(this.driver.listLanguages(request));
  }

  listPlatforms(request: proto.ListPlatformsRequest): Observable<proto.ListPlatformsResponse> {
    this.logger.log('ListPlatforms request received');
    return relayDriverAnswer(this.driver.listPlatforms(request));
  }

  listCategories(request: proto.ListCategoriesRequest): Observable<proto.ListCategoriesResponse> {
    this.logger.log('ListCategories request received');
    return relayDriverAnswer(this.driver.listCategories(request));
  }

  listMechanics(request: proto.ListMechanicsRequest): Observable<proto.ListMechanicsResponse> {
    this.logger.log('ListMechanics request received');
    return relayDriverAnswer(this.driver.listMechanics(request));
  }

  // The username is a user's personal data, so it stays out of the log (#1226).
  findUpstreamAccount(request: proto.FindUpstreamAccountRequest): Observable<proto.FindUpstreamAccountResponse> {
    this.logger.log('FindUpstreamAccount request received');
    return relayDriverAnswer(this.driver.findUpstreamAccount(request));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.driver.dispose();
  }
}
