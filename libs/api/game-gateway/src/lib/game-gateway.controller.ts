import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, GameGateway, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { ConnectGatewayRequest, DisconnectGatewayRequest } from '@board-games-empire/proto-gateway';
import { Body, Controller, Delete, Get, Logger, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { ClsService } from 'nestjs-cls';
import { from, of } from 'rxjs';
import { concatMap, map, tap } from 'rxjs/operators';
import { CreateGameGatewayDto } from './dto';
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
    return this.gameGatewayService.getAll(pagination, abilities.userAbility, abilities.apiAbility);
  }

  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameGateway))
  @Get(':id')
  getById(@Query('id') id: string) {
    const abilities = this.getAbilities();
    return this.gameGatewayService.getById(id, abilities.userAbility, abilities.apiAbility);
  }

  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.GameGateway))
  @Post()
  create(@Session() session: UserSession, @Body() createGameGatewayDto: CreateGameGatewayDto) {
    return from(this.gameGatewayService.create(session.user.id, createGameGatewayDto)).pipe(
      tap((gateway: GameGateway) => this.logger.log(`Created game gateway with name: ${gateway.name}`)),
      concatMap((gateway) => (gateway.enabled ? this.connectToGateway(gateway) : of(gateway))),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameGateway))
  @Patch(':id')
  update(@Query('id') id: string, @Body() updateGameGatewayDto: CreateGameGatewayDto) {
    const abilities = this.getAbilities();
    return from(
      this.gameGatewayService.update(id, updateGameGatewayDto, abilities.userAbility, abilities.apiAbility),
    ).pipe(
      tap((gateway: GameGateway) => this.logger.log(`Updated game gateway with ID: ${gateway.id}`)),
      concatMap((gateway) => {
        if (updateGameGatewayDto.enabled === undefined) {
          return of(gateway);
        }

        return updateGameGatewayDto.enabled ? this.connectToGateway(gateway) : this.disconnectFromGateway(gateway.id);
      }),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.GameGateway))
  @Delete(':id')
  delete(@Query('id') id: string) {
    const abilities = this.getAbilities();
    return from(this.gameGatewayService.delete(id, abilities.userAbility, abilities.apiAbility)).pipe(
      tap((gateway: GameGateway) => this.logger.log(`Deleted game gateway with ID: ${gateway.id}`)),
      concatMap((gateway) => (gateway.enabled ? this.disconnectFromGateway(gateway.id) : of(gateway))),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameGateway))
  @Get(':id/connect')
  connect(@Query('id') id: string) {
    const abilities = this.getAbilities();
    return from(this.gameGatewayService.getById(id, abilities.userAbility, abilities.apiAbility)).pipe(
      concatMap((gateway: GameGateway) => (gateway.enabled ? this.connectToGateway(gateway) : of(gateway))),
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
      map(() => gateway),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameGateway))
  @Get(':id/disconnect')
  disconnect(@Query('id') id: string) {
    const abilities = this.getAbilities();
    return from(this.gameGatewayService.getById(id, abilities.userAbility, abilities.apiAbility)).pipe(
      concatMap((gateway: GameGateway) => this.disconnectFromGateway(gateway.id)),
    );
  }

  private disconnectFromGateway(gatewayId: string) {
    const request: DisconnectGatewayRequest = {
      gatewayId,
    };

    return this.coordinator
      .disconnectGateway(request)
      .pipe(
        tap((response) => this.logger.log(`Disconnect gateway response for ${gatewayId}: ${JSON.stringify(response)}`)),
      );
  }

  private getAbilities() {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    const apiAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return { userAbility, apiAbility };
  }
}
