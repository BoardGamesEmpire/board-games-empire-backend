import { DatabaseService, GameGateway, Prisma, ResourceType } from '@bge/database';
import { GatewayConfigEvent, GatewayConfigEventsService, hashGatewayConfig } from '@bge/gateway-registry';
import { AppAbility } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { accessibleBy, WhereInput } from '@casl/prisma';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaError } from '@status/codes';
import assert from 'node:assert';
import { CreateGameGatewayDto, UpdateGameGatewayDto } from './dto';

@Injectable()
export class GameGatewayService {
  private readonly logger = new Logger(GameGatewayService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly configEvents: GatewayConfigEventsService,
  ) {}

  async getAll(pagination: PaginationQueryDto, userAbility: AppAbility, apiKeyAbility?: AppAbility) {
    return this.db.gameGateway.findMany({
      where: {
        AND: [...this.createGameGatewayWhereAnd(userAbility, apiKeyAbility), { deletedAt: null }],
      },
      skip: pagination.offset,
      take: pagination.limit || 20,
    });
  }

  async getById(id: string, userAbility: AppAbility, apiKeyAbility?: AppAbility) {
    try {
      return await this.db.gameGateway.findUniqueOrThrow({
        where: {
          id,
          AND: [...this.createGameGatewayWhereAnd(userAbility, apiKeyAbility), { deletedAt: null }],
        },
      });
    } catch (error) {
      this.logger.error(`Error fetching game gateway with ID ${id}`, error);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PrismaError.DependentRecordNotFound) {
        throw new NotFoundException(`Game gateway with ID ${id} not found or access denied.`);
      }

      throw error;
    }
  }

  async create(userId: string, createGameGatewayDto: CreateGameGatewayDto): Promise<GameGateway> {
    const gateway = await this.db.gameGateway.create({
      data: {
        ...createGameGatewayDto,
        authParameters: createGameGatewayDto.authParameters || {},
        createdBy: { connect: { id: userId } },
      },
    });

    await this.publishConfigEvent(gateway, 'created');
    return gateway;
  }

  async update(
    gatewayId: string,
    updateGameGatewayDTO: UpdateGameGatewayDto,
    userAbility: AppAbility,
    apiKeyAbility?: AppAbility,
  ): Promise<GameGateway> {
    if (Object.keys(updateGameGatewayDTO).length === 0) {
      throw new BadRequestException('At least one field must be provided for update');
    }

    try {
      const existingGateway = await this.db.gameGateway.count({ where: { id: gatewayId } });
      assert(
        existingGateway > 0,
        new NotFoundException(`Game gateway with ID ${gatewayId} not found or access denied.`),
      );

      const update: Prisma.GameGatewayUpdateInput = {
        ...updateGameGatewayDTO,
        authParameters: updateGameGatewayDTO.authParameters ? updateGameGatewayDTO.authParameters : undefined,
      };

      if (!update.authParameters) {
        delete update.authParameters;
      }

      const gateway = await this.db.gameGateway.update({
        where: {
          id: gatewayId,
          AND: this.createGameGatewayWhereAnd(userAbility, apiKeyAbility),
        },
        data: { ...update },
      });

      await this.publishConfigEvent(gateway, 'updated');
      return gateway;
    } catch (error) {
      this.logger.error(`Error updating game gateway with ID ${gatewayId}`, error);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PrismaError.DependentRecordNotFound) {
        throw new ForbiddenException("You don't have permission to update this resource.");
      }

      throw error;
    }
  }

  /**
   * @todo Consider what should happen to existing connections to the gateway when it is (soft) deleted.
   * Should we disconnect them immediately? Should we mark the gateway as deleted but keep it in the database for a period of time to allow existing connections to gracefully disconnect?
   */
  async delete(gatewayId: string, userAbility: AppAbility, apiKeyAbility?: AppAbility): Promise<GameGateway> {
    try {
      const existingGateway = await this.db.gameGateway.count({ where: { id: gatewayId } });
      assert(existingGateway > 0, new NotFoundException(`Game gateway with ID ${gatewayId} not found.`));

      const gateway = await this.db.gameGateway.update({
        where: {
          id: gatewayId,
          AND: this.createGameGatewayWhereAnd(userAbility, apiKeyAbility),
        },
        data: { deletedAt: new Date() },
      });

      await this.publishConfigEvent(gateway, 'deleted');
      return gateway;
    } catch (error) {
      this.logger.error(`Error deleting game gateway with ID ${gatewayId}`, error);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PrismaError.DependentRecordNotFound) {
        throw new ForbiddenException("You don't have permission to delete this resource.");
      }
      throw error;
    }
  }

  /**
   * Publishes a gateway config event to all subscribed processes. Pub/sub
   * is best-effort — failures here are logged but do NOT propagate as
   * errors to the admin caller. The DB is the source of truth; missed
   * events recover on process restart (bootstrap re-reads from DB) or
   * next config-touching admin action.
   */
  private async publishConfigEvent(gateway: GameGateway, changeType: GatewayConfigEvent['changeType']): Promise<void> {
    const event: GatewayConfigEvent = {
      gatewayId: gateway.id,
      configHash: changeType === 'deleted' ? '' : hashGatewayConfig(gateway),
      changeType,
      timestamp: Date.now(),
    };

    try {
      await this.configEvents.publish(event);
    } catch (error) {
      this.logger.error(
        `Failed to publish ${changeType} event for gateway ${gateway.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private createGameGatewayWhereAnd(userAbility: AppAbility, apiKeyAbility?: AppAbility): WhereInput<GameGateway>[] {
    const whereAnd: WhereInput<GameGateway>[] = [];

    try {
      if (userAbility) {
        whereAnd.push(accessibleBy(userAbility).ofType(ResourceType.GameGateway));
      }
      if (apiKeyAbility) {
        whereAnd.push(accessibleBy(apiKeyAbility).ofType(ResourceType.GameGateway));
      }
    } catch (error) {
      this.logger.error('Error creating where conditions for game gateway access control', error);
      throw new ForbiddenException("You don't have permission to access this resource.");
    }

    return whereAnd;
  }
}
