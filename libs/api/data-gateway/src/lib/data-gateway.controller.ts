import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, DataGateway, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, DefaultPaginationQueryDto, paginated } from '@bge/shared';
import { ConnectGatewayRequest, DisconnectGatewayRequest } from '@boardgamesempire/proto-gateway';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { from, of } from 'rxjs';
import { catchError, concatMap, map, tap } from 'rxjs/operators';
import { DataGatewayService } from './data-gateway.service';
import { CreateDataGatewayDto, UpdateDataGatewayDto } from './dto';

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('data-gateways')
@Controller('data-gateways')
export class DataGatewayController {
  private readonly logger = new Logger(DataGatewayController.name);

  constructor(
    private readonly dataGatewayService: DataGatewayService,
    private readonly coordinator: GatewayCoordinatorClientService,
  ) {}

  @ApiOperation({
    summary: 'List configured DataGateways',
    description:
      'Alphabetical by name. Paginated: `?page=` (1-based) and `?limit=`, with a `pagination` envelope ' +
      'carrying `total`, `totalPages` and `hasMore`. See #230; the row shape is modelled in #402.',
  })
  @ApiPaginatedEnvelope('dataGateways')
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.DataGateway))
  @Get()
  getAll(@Query() pagination: DefaultPaginationQueryDto) {
    return from(this.dataGatewayService.getAll(pagination)).pipe(
      map((page) => paginated('dataGateways', page, pagination, ResourceType.DataGateway)),
    );
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.DataGateway))
  @Get(':id')
  getById(@Param('id') id: string) {
    return from(this.dataGatewayService.getById(id)).pipe(map((dataGateway) => ({ dataGateway })));
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.DataGateway))
  @Post()
  create(@Body() createDataGatewayDto: CreateDataGatewayDto) {
    return from(this.dataGatewayService.create(createDataGatewayDto)).pipe(
      tap((gateway: DataGateway) => this.logger.log(`Created DataGateway with name: ${gateway.name}`)),
      concatMap((gateway) =>
        gateway.enabled
          ? this.connectToGateway(gateway)
          : of({
              dataGateway: gateway,
              connection_response: null,
              connection_attempt: false,
            }),
      ),
    );
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateDataGatewayDto: UpdateDataGatewayDto) {
    return from(this.dataGatewayService.update(id, updateDataGatewayDto)).pipe(
      tap((gateway: DataGateway) => this.logger.log(`Updated DataGateway with ID: ${gateway.id}`)),
      concatMap((gateway) => {
        if (updateDataGatewayDto.enabled === undefined) {
          return of({
            dataGateway: gateway,
            connection_response: null,
            connection_attempt: false,
          });
        }

        return updateDataGatewayDto.enabled ? this.connectToGateway(gateway) : this.disconnectFromGateway(gateway);
      }),
    );
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.DataGateway))
  @Delete(':id')
  delete(@Param('id') id: string) {
    return from(this.dataGatewayService.delete(id)).pipe(
      tap((gateway: DataGateway) => this.logger.log(`Deleted DataGateway with ID: ${gateway.id}`)),
      concatMap((gateway) =>
        gateway.enabled
          ? this.disconnectFromGateway(gateway)
          : of({
              dataGateway: gateway,
              disconnection_response: null,
              disconnection_attempt: false,
            }),
      ),
    );
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
  @Post(':id/connect')
  connect(@Param('id') id: string) {
    return from(this.dataGatewayService.update(id, { enabled: true })).pipe(
      concatMap((gateway: DataGateway) => this.connectToGateway(gateway)),
    );
  }

  private connectToGateway(gateway: DataGateway) {
    const request: ConnectGatewayRequest = {
      gatewayId: gateway.id,
      connectionUrl: gateway.connectionUrl,
      connectionPort: gateway.connectionPort,
      authType: gateway.authType,
      authParametersJson: JSON.stringify(gateway.authParameters || {}),
    };

    // Log the coordinator's error server-side, whether it answers with one or
    // the call itself fails, but never surface it to the client — return a
    // generic, translated message instead (§6).
    const failedAnswer = () => ({
      dataGateway: gateway,
      connection_response: { success: false, message: t('errors.data_gateway.connect_failed') },
      connection_attempt: true,
    });

    return this.coordinator.connectGateway(request).pipe(
      map((response) => {
        if (!response.success) {
          this.logger.error(
            `Coordinator could not connect gateway ${gateway.id}: ${response.error ?? 'No additional info'}`,
          );
          return failedAnswer();
        }

        this.logger.log(`Connect gateway response for ${gateway.id}: ${JSON.stringify(response)}`);
        return { dataGateway: gateway, connection_response: response, connection_attempt: true };
      }),
      catchError((error) => {
        this.logger.error(`Error connecting to gateway ${gateway.id}`, error);
        return of(failedAnswer());
      }),
    );
  }

  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
  @Post(':id/disconnect')
  disconnect(@Param('id') id: string) {
    return from(this.dataGatewayService.update(id, { enabled: false })).pipe(
      concatMap((gateway: DataGateway) => this.disconnectFromGateway(gateway)),
    );
  }

  private disconnectFromGateway(gateway: DataGateway) {
    const request: DisconnectGatewayRequest = {
      gatewayId: gateway.id,
    };

    // As on connect, the coordinator's error stays in the server log (§6).
    const failedAnswer = () => ({
      dataGateway: gateway,
      disconnection_response: { success: false, message: t('errors.data_gateway.disconnect_failed') },
      disconnection_attempt: true,
    });

    return this.coordinator.disconnectGateway(request).pipe(
      map((response) => {
        if (!response.success) {
          this.logger.error(
            `Coordinator could not disconnect gateway ${gateway.id}: ${response.error ?? 'No additional info'}`,
          );
          return failedAnswer();
        }

        this.logger.log(`Disconnect gateway response for ${gateway.id}: ${JSON.stringify(response)}`);
        return { dataGateway: gateway, disconnection_response: response, disconnection_attempt: true };
      }),
      catchError((error) => {
        this.logger.error(`Error disconnecting from gateway ${gateway.id}`, error);
        return of(failedAnswer());
      }),
    );
  }
}
