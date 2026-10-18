import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, DataGateway, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto, paginated, PaginatedResponseDto } from '@bge/shared';
import { ConnectGatewayRequest, DisconnectGatewayRequest } from '@boardgamesempire/proto-gateway';
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from, of } from 'rxjs';
import { catchError, concatMap, map, tap } from 'rxjs/operators';
import { DataGatewayService } from './data-gateway.service';
import { toDataGatewayView } from './data-gateway.view';
import {
  CreateDataGatewayDto,
  DataGatewayConnectAnswerDto,
  DataGatewayDisconnectAnswerDto,
  DataGatewayEnvelopeDto,
  DataGatewayInterviewAnswerDto,
  DataGatewayResponseDto,
  UpdateDataGatewayDto,
} from './dto';

const PaginatedDataGatewaysResponse = PaginatedResponseDto(DataGatewayResponseDto, 'dataGateways');

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
      'carrying `total`, `totalPages` and `hasMore`. See #230. Rows carry no stored credentials (#753).',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedDataGatewaysResponse })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.DataGateway))
  @Get()
  getAll(@Query() pagination: DefaultPaginationQueryDto) {
    return from(this.dataGatewayService.getAll(pagination)).pipe(
      map((page) =>
        paginated(
          'dataGateways',
          { rows: page.rows.map(toDataGatewayView), total: page.total },
          pagination,
          ResourceType.DataGateway,
        ),
      ),
    );
  }

  @ApiResponse({ status: Http.Ok, type: DataGatewayEnvelopeDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.DataGateway))
  @Get(':id')
  getById(@Param('id') id: string) {
    return from(this.dataGatewayService.getById(id)).pipe(
      map((dataGateway) => ({ dataGateway: toDataGatewayView(dataGateway) })),
    );
  }

  @ApiResponse({ status: Http.Created, type: DataGatewayConnectAnswerDto })
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
              dataGateway: toDataGatewayView(gateway),
              connection_response: null,
              connection_attempt: false,
            }),
      ),
    );
  }

  @ApiExtraModels(DataGatewayConnectAnswerDto, DataGatewayDisconnectAnswerDto)
  @ApiResponse({
    status: Http.Ok,
    description:
      'The connect answer when `enabled` is true, the disconnect answer when false, and either with no attempt otherwise',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(DataGatewayConnectAnswerDto) },
        { $ref: getSchemaPath(DataGatewayDisconnectAnswerDto) },
      ],
    },
  })
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
            dataGateway: toDataGatewayView(gateway),
            connection_response: null,
            connection_attempt: false,
          });
        }

        return updateDataGatewayDto.enabled ? this.connectToGateway(gateway) : this.disconnectFromGateway(gateway);
      }),
    );
  }

  @ApiResponse({ status: Http.Ok, type: DataGatewayDisconnectAnswerDto })
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
              dataGateway: toDataGatewayView(gateway),
              disconnection_response: null,
              disconnection_attempt: false,
            }),
      ),
    );
  }

  @ApiResponse({ status: Http.Created, type: DataGatewayConnectAnswerDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
  @Post(':id/connect')
  connect(@Param('id') id: string) {
    return from(this.dataGatewayService.update(id, { enabled: true })).pipe(
      concatMap((gateway: DataGateway) => this.connectToGateway(gateway)),
    );
  }

  @ApiOperation({
    summary: 'Interview a DataGateway now',
    description:
      'However recent its answers. Waits for the interview, and the call has no deadline yet (#722). Answers with ' +
      'the row read again, so `interview` shows the result. A failed interview is recorded on the row, and the ' +
      "answer carries generic copy, never the coordinator's error.",
  })
  @ApiResponse({ status: Http.Ok, type: DataGatewayInterviewAnswerDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'No such DataGateway, or it was deleted' })
  @ApiResponse({ status: Http.Conflict, description: 'The DataGateway is disabled' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.DataGateway))
  @HttpCode(Http.Ok)
  @Post(':id/interview')
  interview(@Param('id') id: string) {
    return from(this.dataGatewayService.getById(id)).pipe(
      concatMap((gateway) => {
        // The registry refuses a disabled DataGateway too, but saying so here
        // gives the admin the reason rather than a generic failure.
        if (!gateway.enabled) {
          throw new ConflictException(t('errors.data_gateway.disabled', { id }));
        }

        return this.reinterviewGateway(id);
      }),
      // Read again whatever the outcome: a failure is recorded on the row too.
      concatMap((interview_response) =>
        from(this.dataGatewayService.getById(id)).pipe(
          map((gateway) => ({
            dataGateway: toDataGatewayView(gateway),
            interview_attempt: true as const,
            interview_response,
          })),
        ),
      ),
    );
  }

  private reinterviewGateway(gatewayId: string) {
    // As on connect, the coordinator's error stays in the server log.
    const failed = () => ({ success: false, message: t('errors.data_gateway.interview_failed') });

    return this.coordinator.reinterviewGateway({ gatewayId }).pipe(
      map((response) => {
        if (!response.success) {
          this.logger.error(
            `Coordinator could not interview gateway ${gatewayId}: ${response.error ?? 'No additional info'}`,
          );
          return failed();
        }

        return { success: true };
      }),
      catchError((error) => {
        this.logger.error(`Error interviewing gateway ${gatewayId}`, error);
        return of(failed());
      }),
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
      dataGateway: toDataGatewayView(gateway),
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
        return { dataGateway: toDataGatewayView(gateway), connection_response: response, connection_attempt: true };
      }),
      catchError((error) => {
        this.logger.error(`Error connecting to gateway ${gateway.id}`, error);
        return of(failedAnswer());
      }),
    );
  }

  @ApiResponse({ status: Http.Created, type: DataGatewayDisconnectAnswerDto })
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
      dataGateway: toDataGatewayView(gateway),
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
        return {
          dataGateway: toDataGatewayView(gateway),
          disconnection_response: response,
          disconnection_attempt: true,
        };
      }),
      catchError((error) => {
        this.logger.error(`Error disconnecting from gateway ${gateway.id}`, error);
        return of(failedAnswer());
      }),
    );
  }
}
