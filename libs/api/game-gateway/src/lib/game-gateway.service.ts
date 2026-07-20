import type { GameGateway } from '@bge/database';
import { Action, DatabaseService, isPrismaDependentRecordNotFoundError, Prisma, ResourceType } from '@bge/database';
import { GatewayConfigEvent, GatewayConfigEventsService, hashGatewayConfig } from '@bge/gateway-registry';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateGameGatewayDto, UpdateGameGatewayDto } from './dto';

@Injectable()
export class GameGatewayService {
  private readonly logger = new Logger(GameGatewayService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly configEvents: GatewayConfigEventsService,
    private readonly abilityService: AbilityService,
  ) {}

  async getAll(pagination: PaginationQueryDto) {
    return this.db.gameGateway.findMany({
      where: {
        AND: [
          ...this.abilityService.getCurrentResourceConditions(ResourceType.GameGateway, Action.read),
          { deletedAt: null },
        ],
      },
      skip: pagination.offset,
      take: pagination.limit || 20,
    });
  }

  async getById(id: string) {
    try {
      return await this.db.gameGateway.findUniqueOrThrow({
        where: {
          id,
          AND: [
            ...this.abilityService.getCurrentResourceConditions(ResourceType.GameGateway, Action.read),
            { deletedAt: null },
          ],
        },
      });
    } catch (error) {
      this.logger.error(`Error fetching game gateway with ID ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new NotFoundException(t('errors.game_gateway.not_found_or_denied', { id }));
      }

      throw error;
    }
  }

  async create(createGameGatewayDto: CreateGameGatewayDto): Promise<GameGateway> {
    const userId = this.abilityService.getActingUserId();

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

  async update(gatewayId: string, updateGameGatewayDTO: UpdateGameGatewayDto): Promise<GameGateway> {
    if (Object.keys(updateGameGatewayDTO).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    try {
      const existingGateway = await this.db.gameGateway.count({ where: { id: gatewayId } });
      if (existingGateway === 0) {
        throw new NotFoundException(t('errors.game_gateway.not_found', { id: gatewayId }));
      }

      const update: Prisma.GameGatewayUpdateInput = {
        ...updateGameGatewayDTO,
        authParameters: updateGameGatewayDTO.authParameters || undefined,
      };

      if (!update.authParameters) {
        delete update.authParameters;
      }

      const gateway = await this.db.gameGateway.update({
        where: {
          id: gatewayId,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameGateway, Action.update),
        },
        data: { ...update },
      });

      await this.publishConfigEvent(gateway, 'updated');
      return gateway;
    } catch (error) {
      this.logger.error(`Error updating game gateway with ID ${gatewayId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }

  /**
   * @todo Consider what should happen to existing connections to the gateway when it is (soft) deleted.
   */
  async delete(gatewayId: string): Promise<GameGateway> {
    try {
      const existingGateway = await this.db.gameGateway.count({ where: { id: gatewayId } });
      if (existingGateway === 0) {
        throw new NotFoundException(t('errors.game_gateway.not_found', { id: gatewayId }));
      }

      const gateway = await this.db.gameGateway.update({
        where: {
          id: gatewayId,
          AND: [...this.abilityService.getCurrentResourceConditions(ResourceType.GameGateway, Action.delete)],
        },
        data: { deletedAt: new Date() },
      });

      await this.publishConfigEvent(gateway, 'deleted');
      return gateway;
    } catch (error) {
      this.logger.error(`Error deleting game gateway with ID ${gatewayId}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.delete'));
      }

      throw error;
    }
  }

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
}
