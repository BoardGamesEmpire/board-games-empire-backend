import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, GameGateway, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { ConnectGatewayRequest, DisconnectGatewayRequest } from '@board-games-empire/proto-gateway';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { ClsService } from 'nestjs-cls';
import { from, of } from 'rxjs';
import { catchError, concatMap, map, tap } from 'rxjs/operators';
import { CreateGameGatewayDto, UpdateGameGatewayDto } from './dto';
import { GameGatewayService } from './game-gateway.service';

@UseGuards(PoliciesGuard)
@ApiTags('game-gateways')
@Controller('game-gateways')
export class GameGatewayController {
  private readonly logger = new Logger(GameGatewayController.name);

  constructor(
    private gameGatewayService: GameGatewayService,
    private readonly cls: ClsService,
    private readonly coordinator: GatewayCoordinatorClientService,
  ) {}

  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameGateway))
  @Get()
  getAll(@Query() pagination: PaginationQueryDto) {
    const abilities = this.getAbilities();
    return from(this.gameGatewayService.getAll(pagination, abilities.userAbility, abilities.apiAbility)).pipe(
      map((gateways) => ({ gateways })),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameGateway))
  @Get(':id')
  getById(@Param('id') id: string) {
    const abilities = this.getAbilities();
    return from(this.gameGatewayService.getById(id, abilities.userAbility, abilities.apiAbility)).pipe(
      map((gateway) => ({ gateway })),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.GameGateway))
  @Post()
  create(@Session() session: UserSession, @Body() createGameGatewayDto: CreateGameGatewayDto) {
    return from(this.gameGatewayService.create(session.user.id, createGameGatewayDto)).pipe(
      tap((gateway: GameGateway) => this.logger.log(`Created game gateway with name: ${gateway.name}`)),
      concatMap((gateway) =>
        gateway.enabled
          ? this.connectToGateway(gateway)
          : of({
              gateway,
              connection_response: null,
              connection_attempt: false,
            }),
      ),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameGateway))
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateGameGatewayDto: UpdateGameGatewayDto) {
    const abilities = this.getAbilities();
    return from(
      this.gameGatewayService.update(id, updateGameGatewayDto, abilities.userAbility, abilities.apiAbility),
    ).pipe(
      tap((gateway: GameGateway) => this.logger.log(`Updated game gateway with ID: ${gateway.id}`)),
      concatMap((gateway) => {
        if (updateGameGatewayDto.enabled === undefined) {
          return of({
            gateway,
            connection_response: null,
            connection_attempt: false,
          });
        }

        return updateGameGatewayDto.enabled ? this.connectToGateway(gateway) : this.disconnectFromGateway(gateway);
      }),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.GameGateway))
  @Delete(':id')
  delete(@Param('id') id: string) {
    const abilities = this.getAbilities();
    return from(this.gameGatewayService.delete(id, abilities.userAbility, abilities.apiAbility)).pipe(
      tap((gateway: GameGateway) => this.logger.log(`Deleted game gateway with ID: ${gateway.id}`)),
      concatMap((gateway) =>
        gateway.enabled
          ? this.disconnectFromGateway(gateway)
          : of({
              gateway,
              disconnection_response: null,
              disconnection_attempt: false,
            }),
      ),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameGateway))
  @Get(':id/connect')
  connect(@Param('id') id: string) {
    const abilities = this.getAbilities();
    return from(
      this.gameGatewayService.update(id, { enabled: true }, abilities.userAbility, abilities.apiAbility),
    ).pipe(
      concatMap((gateway: GameGateway) =>
        gateway.enabled
          ? this.connectToGateway(gateway)
          : of({
              gateway,
              connection_response: { success: false, message: 'Gateway is disabled' },
              connection_attempt: false,
            }),
      ),
    );
  }

  private connectToGateway(gateway: GameGateway) {
    const request: ConnectGatewayRequest = {
      gatewayId: gateway.id,
      connectionUrl: gateway.connectionUrl,
      connectionPort: gateway.connectionPort,
      authType: gateway.authType,
      authParametersJson: JSON.stringify(gateway.authParameters || {}),
    };

    return this.coordinator.connectGateway(request).pipe(
      tap((response) => this.logger.log(`Connect gateway response for ${gateway.id}: ${JSON.stringify(response)}`)),
      map((response) => ({
        gateway,
        connection_response: response,
        connection_attempt: true,
      })),
      catchError((error) => {
        this.logger.error(`Error connecting to gateway ${gateway.id}`, error);
        return of({
          gateway,
          connection_response: { success: false, message: error.message },
          connection_attempt: true,
        });
      }),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameGateway))
  @Get(':id/disconnect')
  disconnect(@Param('id') id: string) {
    const abilities = this.getAbilities();
    return from(
      this.gameGatewayService.update(id, { enabled: false }, abilities.userAbility, abilities.apiAbility),
    ).pipe(concatMap((gateway: GameGateway) => this.disconnectFromGateway(gateway)));
  }

  private disconnectFromGateway(gateway: GameGateway) {
    const request: DisconnectGatewayRequest = {
      gatewayId: gateway.id,
    };

    return this.coordinator.disconnectGateway(request).pipe(
      tap((response) => this.logger.log(`Disconnect gateway response for ${gateway.id}: ${JSON.stringify(response)}`)),
      map((response) => ({
        gateway,
        disconnection_response: response,
        disconnection_attempt: true,
      })),
      catchError((error) => {
        this.logger.error(`Error disconnecting from gateway ${gateway.id}`, error);
        return of({
          gateway,
          disconnection_response: { success: false, message: error.message },
          disconnection_attempt: true,
        });
      }),
    );
  }

  private getAbilities() {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    const apiAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return { userAbility, apiAbility };
  }
}
