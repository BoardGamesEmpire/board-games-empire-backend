import { DatabaseService, GameGateway, Prisma } from '@bge/database';
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

  constructor(private db: DatabaseService) {}

  async getAll(pagination: PaginationQueryDto, userAbility: AppAbility, apiKeyAbility?: AppAbility) {
    return this.db.gameGateway.findMany({
      where: {
        AND: [...this.createGameGatewayWhereAnd(userAbility, apiKeyAbility), { deletedAt: null }],
      },
      skip: pagination.offset,
      take: pagination.limit,
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

  async create(userId: string, createGameGatewayDto: CreateGameGatewayDto) {
    return this.db.gameGateway.create({
      data: {
        ...createGameGatewayDto,
        authParameters: createGameGatewayDto.authParameters || {},

        createdBy: {
          connect: {
            id: userId,
          },
        },
      },
    });
  }

  async update(
    gatewayId: string,
    updateGameGatewayDTO: UpdateGameGatewayDto,
    userAbility: AppAbility,
    apiKeyAbility?: AppAbility,
  ) {
    if (Object.keys(updateGameGatewayDTO).length === 0) {
      throw new BadRequestException('At least one field must be provided for update');
    }

    try {
      const existingGateway = await this.db.gameGateway.count({
        where: {
          id: gatewayId,
        },
      });

      assert(
        existingGateway > 0,
        new NotFoundException(`Game gateway with ID ${gatewayId} not found or access denied.`),
      );

      const update: Prisma.GameGatewayUpdateInput = {
        ...updateGameGatewayDTO,
        authParameters: updateGameGatewayDTO.authParameters ? updateGameGatewayDTO.authParameters : undefined,
      };

      // Ensure we don't set authParameters to null if it's not included in the update DTO
      if (!update.authParameters) {
        delete update.authParameters;
      }

      return await this.db.gameGateway.update({
        where: {
          id: gatewayId,
          AND: this.createGameGatewayWhereAnd(userAbility, apiKeyAbility),
        },
        data: {
          ...update,
        },
      });
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
  async delete(gatewayId: string, userAbility: AppAbility, apiKeyAbility?: AppAbility) {
    try {
      const existingGateway = await this.db.gameGateway.count({
        where: {
          id: gatewayId,
        },
      });

      assert(existingGateway > 0, new NotFoundException(`Game gateway with ID ${gatewayId} not found.`));

      return await this.db.gameGateway.update({
        where: {
          id: gatewayId,
          AND: this.createGameGatewayWhereAnd(userAbility, apiKeyAbility),
        },
        data: {
          deletedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(`Error deleting game gateway with ID ${gatewayId}`, error);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PrismaError.DependentRecordNotFound) {
        throw new ForbiddenException("You don't have permission to delete this resource.");
      }

      throw error;
    }
  }

  private createGameGatewayWhereAnd(userAbility: AppAbility, apiKeyAbility?: AppAbility): WhereInput<GameGateway>[] {
    const whereAnd: WhereInput<GameGateway>[] = [];

    try {
      if (userAbility) {
        whereAnd.push(accessibleBy(userAbility).GameGateway);
      }
      if (apiKeyAbility) {
        whereAnd.push(accessibleBy(apiKeyAbility).GameGateway);
      }
    } catch (error) {
      this.logger.error('Error creating where conditions for game gateway access control', error);
      throw new ForbiddenException("You don't have permission to access this resource.");
    }

    return whereAnd;
  }
}
