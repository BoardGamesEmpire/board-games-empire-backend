import type { DataGateway } from '@bge/database';
import {
  Action,
  DatabaseService,
  DataGatewayCapability,
  isPrismaDependentRecordNotFoundError,
  Prisma,
  ResourceType,
} from '@bge/database';
import {
  GatewayConfigEvent,
  GatewayConfigEventsService,
  hashGatewayConfig,
  SECTION_ORDER,
  VocabularySectionQueue,
} from '@bge/gateway-registry';
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
import { WITH_SECTIONS, type DataGatewayWithSections } from './data-gateway.view';
import { CreateDataGatewayDto, UpdateDataGatewayDto } from './dto';

@Injectable()
export class DataGatewayService {
  private readonly logger = new Logger(DataGatewayService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly configEvents: GatewayConfigEventsService,
    private readonly sectionQueue: VocabularySectionQueue,
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
  async getAll(pagination: PaginationQueryDto): Promise<PaginatedRows<DataGatewayWithSections>> {
    const where: Prisma.DataGatewayWhereInput = {
      AND: [
        this.scopeComposer.compose(
          ResourceType.DataGateway,
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
        this.db.dataGateway.findMany({
          where,
          // `DataGateway.name` is `@unique`, so this is already a total order and
          // needs no tie-breaker of its own.
          orderBy: { name: 'asc' },
          skip: pagination.skip,
          take: pagination.pageSize,
          include: WITH_SECTIONS,
        }),

        this.db.dataGateway.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  // Under the conditions of what the caller is about to do: a key's scope can
  // grant update on one DataGateway beside read on all, so a route that writes
  // finds its row under update, and one that wrote reads it back the same way.
  async getById(id: string, action: Action = Action.read): Promise<DataGatewayWithSections> {
    try {
      return await this.db.dataGateway.findUniqueOrThrow({
        where: {
          id,
          AND: [
            // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
            ...this.abilityService.getCurrentResourceConditions(ResourceType.DataGateway, action),
            { deletedAt: null },
          ],
        },
        include: WITH_SECTIONS,
      });
    } catch (error) {
      this.rethrowFailure(
        error,
        () => new NotFoundException(t('errors.data_gateway.not_found_or_denied', { id })),
        `Error fetching DataGateway with ID ${id}`,
      );
    }
  }

  async create(createDataGatewayDto: CreateDataGatewayDto): Promise<DataGatewayWithSections> {
    const userId = this.abilityService.getActingUserId();

    const gateway = await this.db.dataGateway.create({
      data: {
        ...createDataGatewayDto,
        authParameters: createDataGatewayDto.authParameters || {},
        createdBy: { connect: { id: userId } },
      },
      include: WITH_SECTIONS,
    });

    await this.publishConfigEvent(gateway, 'created');
    return gateway;
  }

  async update(gatewayId: string, updateDataGatewayDTO: UpdateDataGatewayDto): Promise<DataGatewayWithSections> {
    if (Object.keys(updateDataGatewayDTO).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    // Live rows only, in the count and again in the write. Every read hides a
    // tombstone, so an update that still reached one would publish 'updated'
    // and reconnect a gateway the API says does not exist.
    try {
      const before = await this.db.dataGateway.findFirst({
        where: { id: gatewayId, deletedAt: null },
        select: { disabledCapabilities: true },
      });
      if (!before) {
        throw new NotFoundException(t('errors.data_gateway.not_found', { id: gatewayId }));
      }

      const update: Prisma.DataGatewayUpdateInput = {
        ...updateDataGatewayDTO,
        authParameters: updateDataGatewayDTO.authParameters || undefined,
      };

      if (!update.authParameters) {
        delete update.authParameters;
      }

      // Stored like the interview's lists, in the enum's order with no
      // repeats, so an unchanged list writes identically (#715).
      const switchedOff = updateDataGatewayDTO.disabledCapabilities;
      if (switchedOff) {
        update.disabledCapabilities = Object.values(DataGatewayCapability).filter((capability) =>
          switchedOff.includes(capability),
        );
      }

      const gateway = await this.db.dataGateway.update({
        where: {
          id: gatewayId,
          deletedAt: null,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.DataGateway, Action.update),
        },
        data: { ...update },
        include: WITH_SECTIONS,
      });

      await this.publishConfigEvent(gateway, 'updated');

      // A list switched back on loads now, not after the next interview, up
      // to a day later (#718). Not awaited: queueing never rejects, but it
      // hangs while the queue's Redis is unreachable.
      const switchedOn = listsSwitchedOn(before.disabledCapabilities, gateway);
      if (switchedOn.length > 0) {
        void this.sectionQueue.enqueue(gateway.id, switchedOn, gateway.disabledCapabilities);
      }

      return gateway;
    } catch (error) {
      this.rethrowFailure(
        error,
        () => new ForbiddenException(t('common.forbidden.update')),
        `Error updating DataGateway with ID ${gatewayId}`,
      );
    }
  }

  /**
   * @todo Consider what should happen to existing connections to the gateway when it is (soft) deleted.
   */
  async delete(gatewayId: string): Promise<DataGatewayWithSections> {
    try {
      const existingGateway = await this.db.dataGateway.count({ where: { id: gatewayId, deletedAt: null } });
      if (existingGateway === 0) {
        throw new NotFoundException(t('errors.data_gateway.not_found', { id: gatewayId }));
      }

      const gateway = await this.db.dataGateway.update({
        where: {
          id: gatewayId,
          deletedAt: null,
          // eslint-disable-next-line no-restricted-syntax -- single-row soft delete by id, not a collection read
          AND: [...this.abilityService.getCurrentResourceConditions(ResourceType.DataGateway, Action.delete)],
        },
        data: { deletedAt: new Date() },
        include: WITH_SECTIONS,
      });

      await this.publishConfigEvent(gateway, 'deleted');
      return gateway;
    } catch (error) {
      this.rethrowFailure(
        error,
        () => new ForbiddenException(t('common.forbidden.delete')),
        `Error deleting DataGateway with ID ${gatewayId}`,
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

  private async publishConfigEvent(gateway: DataGateway, changeType: GatewayConfigEvent['changeType']): Promise<void> {
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

/** The lists the DataGateway declares that were switched off before the update and aren't after it. */
function listsSwitchedOn(before: readonly DataGatewayCapability[], gateway: DataGateway): DataGatewayCapability[] {
  return SECTION_ORDER.filter(
    (capability) =>
      before.includes(capability) &&
      !gateway.disabledCapabilities.includes(capability) &&
      gateway.capabilities.includes(capability),
  );
}
