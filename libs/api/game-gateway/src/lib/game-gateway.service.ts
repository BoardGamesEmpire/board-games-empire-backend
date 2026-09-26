import type { GameGateway } from '@bge/database';
import { Action, DatabaseService, isPrismaDependentRecordNotFoundError, Prisma, ResourceType } from '@bge/database';
import { GatewayConfigEvent, GatewayConfigEventsService, hashGatewayConfig } from '@bge/gateway-registry';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer, Unscoped } from '@bge/permissions';
import { PaginationQueryDto, type PaginatedRows } from '@bge/shared';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateGameGatewayDto, UpdateGameGatewayDto } from './dto';

@Injectable()
export class GameGatewayService {
  private readonly logger = new Logger(GameGatewayService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly configEvents: GatewayConfigEventsService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * One page of gateways plus the total matching count for the response
   * envelope (#372). Both come from one REPEATABLE READ snapshot, so a gateway
   * registered or soft-deleted mid-request cannot make `total` disagree with
   * the rows sent.
   *
   * Composed as `Unscoped` (#516; `ScopeComposer.compose` says why a read
   * with no scope composes at all): gateways are installation configuration,
   * with no per-caller row set to name. Hiding tombstones is the same for
   * every caller, so `deletedAt: null` is a filter beside the composed clause.
   */
  async getAll(pagination: PaginationQueryDto): Promise<PaginatedRows<GameGateway>> {
    const where: Prisma.GameGatewayWhereInput = {
      AND: [
        this.scopeComposer.compose(
          ResourceType.GameGateway,
          Action.read,
          Unscoped(
            'staff-only installation configuration: every catalog role that reads gateways reads every row (KNOWN_READ_CEILINGS)',
          ),
        ),
        { deletedAt: null },
      ],
    };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.gameGateway.findMany({
          where,
          // `GameGateway.name` is `@unique`, so this is already a total order and
          // needs no tie-breaker of its own.
          orderBy: { name: 'asc' },
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.gameGateway.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  async getById(id: string) {
    try {
      return await this.db.gameGateway.findUniqueOrThrow({
        where: {
          id,
          AND: [
            // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
            ...this.abilityService.getCurrentResourceConditions(ResourceType.GameGateway, Action.read),
            { deletedAt: null },
          ],
        },
      });
    } catch (error) {
      this.rethrowFailure(
        error,
        () => new NotFoundException(t('errors.game_gateway.not_found_or_denied', { id })),
        `Error fetching game gateway with ID ${id}`,
      );
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

    // Live rows only, in the count and again in the write. Every read hides a
    // tombstone, so an update that still reached one would publish 'updated'
    // and reconnect a gateway the API says does not exist.
    try {
      const existingGateway = await this.db.gameGateway.count({ where: { id: gatewayId, deletedAt: null } });
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
          deletedAt: null,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.GameGateway, Action.update),
        },
        data: { ...update },
      });

      await this.publishConfigEvent(gateway, 'updated');
      return gateway;
    } catch (error) {
      this.rethrowFailure(
        error,
        () => new ForbiddenException(t('common.forbidden.update')),
        `Error updating game gateway with ID ${gatewayId}`,
      );
    }
  }

  /**
   * @todo Consider what should happen to existing connections to the gateway when it is (soft) deleted.
   */
  async delete(gatewayId: string): Promise<GameGateway> {
    try {
      const existingGateway = await this.db.gameGateway.count({ where: { id: gatewayId, deletedAt: null } });
      if (existingGateway === 0) {
        throw new NotFoundException(t('errors.game_gateway.not_found', { id: gatewayId }));
      }

      const gateway = await this.db.gameGateway.update({
        where: {
          id: gatewayId,
          deletedAt: null,
          // eslint-disable-next-line no-restricted-syntax -- single-row soft delete by id, not a collection read
          AND: [...this.abilityService.getCurrentResourceConditions(ResourceType.GameGateway, Action.delete)],
        },
        data: { deletedAt: new Date() },
      });

      await this.publishConfigEvent(gateway, 'deleted');
      return gateway;
    } catch (error) {
      this.rethrowFailure(
        error,
        () => new ForbiddenException(t('common.forbidden.delete')),
        `Error deleting game gateway with ID ${gatewayId}`,
      );
    }
  }

  /**
   * One failure classifier for the by-id reads and writes, and the log level
   * is the point:
   *
   * - An `HttpException` is the answer the endpoint is specified to give — the
   *   404 for an unknown or soft-deleted id. Rethrown untouched and not logged
   *   at error, where a client's 4xx would read as a defect to alerting.
   * - A `P2025` is the scoped statement matching no row, which the caller's
   *   ceiling or a concurrent delete can cause. Mapped, at `debug`.
   * - Anything else is unexpected and keeps the full error log.
   */
  private rethrowFailure(error: unknown, whenNotMatched: () => HttpException, context: string): never {
    if (error instanceof HttpException) {
      throw error;
    }

    if (isPrismaDependentRecordNotFoundError(error)) {
      this.logger.debug(`${context}: matched no row`);
      throw whenNotMatched();
    }

    this.logger.error(context, error);
    throw error;
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
