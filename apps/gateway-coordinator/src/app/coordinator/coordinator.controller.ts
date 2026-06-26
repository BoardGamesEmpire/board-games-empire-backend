import type * as proto from '@boardgamesempire/proto-gateway';
import { CoordinatorServiceController, CoordinatorServiceControllerMethods } from '@boardgamesempire/proto-gateway';
import { Controller, Logger } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CoordinatorService } from './coordinator.service';
import { GameSearchService } from './game-search.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

@CoordinatorServiceControllerMethods()
@Controller()
export class CoordinatorController implements CoordinatorServiceController {
  private readonly logger = new Logger(CoordinatorController.name);

  constructor(
    private readonly coordinatorService: CoordinatorService,
    private readonly gameSearchService: GameSearchService,
    private readonly gameImportEnqueuer: GameImportEnqueuerService,
  ) {}

  ping(request: proto.PingRequest): proto.PingResponse {
    this.logger.log('Ping request received');
    return this.coordinatorService.ping(request);
  }

  check(request: proto.HealthCheckRequest): proto.HealthCheckResponse {
    return this.coordinatorService.healthCheck(request);
  }

  connectGateway(request: proto.ConnectGatewayRequest): Promise<proto.ConnectGatewayResponse> {
    return this.coordinatorService.connectGateway(request);
  }

  disconnectGateway(request: proto.DisconnectGatewayRequest): proto.DisconnectGatewayResponse {
    return this.coordinatorService.disconnectGateway(request);
  }

  searchGames(request: proto.SearchGamesRequest): Observable<proto.SearchGameResult> {
    return this.gameSearchService.searchGames(request);
  }

  fetchGame(request: proto.CoordinatorFetchGameRequest): Observable<proto.CoordinatorFetchGameResponse> {
    return this.gameSearchService.fetchGame(request);
  }

  fetchExpansions(request: proto.CoordinatorFetchExpansionsRequest): Observable<proto.SearchGameResult> {
    return this.gameSearchService.fetchExpansions(request);
  }

  /**
   * Creates a new import job for a base game and optional expansions.
   */
  startGameImport(request: proto.StartGameImportRequest): Observable<proto.StartGameImportResponse> {
    return from(
      this.gameImportEnqueuer.enqueue({
        correlationId: request.correlationId,
        gatewayId: request.gatewayId,
        externalId: request.externalId,
        expansionExternalIds: request.expansionExternalIds ?? [],
        locale: request.locale ?? undefined,
        userId: request.userId ?? null,
      }),
    ).pipe(
      map(
        (result) =>
          ({
            correlationId: request.correlationId,
            batchId: result.batchId,
            baseJobId: result.baseJobId,
            expansionJobIds: result.expansionJobIds,
          }) satisfies proto.StartGameImportResponse,
      ),
    );
  }
}
