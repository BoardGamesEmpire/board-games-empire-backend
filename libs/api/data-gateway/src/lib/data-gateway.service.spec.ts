import type { DataGateway } from '@bge/database';
import { Action, Prisma, ResourceType } from '@bge/database';
import { GatewayConfigEventsService } from '@bge/gateway-registry';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  paginationQuery,
  shippedReadReaches,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { DataGatewayService } from './data-gateway.service';
import type { CreateDataGatewayDto, UpdateDataGatewayDto } from './dto';

const COND = { id: 'sentinel-condition' };
const COMPOSED_LIST_WHERE = { AND: [{ AND: [COND] }, { deletedAt: null }] };

/** Prisma's answer when a statement's `where` matches no row. */
const noRowMatched = () =>
  new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 'test' });

describe('DataGatewayService', () => {
  let service: DataGatewayService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let configEvents: jest.Mocked<Pick<GatewayConfigEventsService, 'publish'>>;
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);
    configEvents = { publish: jest.fn().mockResolvedValue(undefined) };

    const ctx = await createTestingModuleWithDb({
      providers: [
        DataGatewayService,
        // The REAL composer over the mocked ability service, so the where-clause
        // assertions below test the merge the list actually depends on.
        ScopeComposer,
        { provide: GatewayConfigEventsService, useValue: configEvents },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(DataGatewayService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
  });

  afterEach(() => jest.clearAllMocks());

  it('getAll composes DataGateway as unscoped, with the deletedAt filter beside it', async () => {
    db.dataGateway.findMany.mockResolvedValue([]);
    db.dataGateway.count.mockResolvedValue(0);

    await service.getAll(paginationQuery({ limit: 20 }));

    expect(compose).toHaveBeenCalledWith(
      ResourceType.DataGateway,
      Action.read,
      expect.objectContaining({ kind: 'unscoped', reason: expect.any(String) }),
    );
    expect(db.dataGateway.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: COMPOSED_LIST_WHERE }));
  });

  // The Unscoped reason is a claim about the catalog, and this is where it is
  // checked: a conditioned read granted later fails here, beside the
  // declaration it would falsify, and not only in the catalog's own pin.
  it('stays unscoped only while every catalog role that reads gateways reads every row', () => {
    expect(new Set(shippedReadReaches(ResourceType.DataGateway))).toEqual(new Set(['every row']));
  });

  // #372: one snapshot for rows and count, and the same `where` for both — a
  // count that dropped the `deletedAt` filter would total the tombstones too.
  it('counts through the same where as the rows, in one REPEATABLE READ transaction', async () => {
    db.dataGateway.findMany.mockResolvedValue([]);
    db.dataGateway.count.mockResolvedValue(3);

    const page = await service.getAll(paginationQuery({ limit: 20 }));

    expect(db.dataGateway.count).toHaveBeenCalledWith({ where: COMPOSED_LIST_WHERE });
    expect(page).toEqual({ rows: [], total: 3 });

    const { operations, options } = batchTransactionCall(db);
    expect(operations).toHaveLength(2);
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });

  it('getById → read, ANDed with the deletedAt filter', async () => {
    db.dataGateway.findUniqueOrThrow.mockResolvedValue({ id: 'gw-1' } as DataGateway);

    await service.getById('gw-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.DataGateway, Action.read);
    expect(db.dataGateway.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'gw-1', AND: [COND, { deletedAt: null }] }) }),
    );
  });

  it('create does not filter by abilities and publishes a created event', async () => {
    db.dataGateway.create.mockResolvedValue({ id: 'gw-1' } as DataGateway);

    await service.create({ name: 'BGG' } as CreateDataGatewayDto);

    expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
    expect(configEvents.publish).toHaveBeenCalledWith(expect.objectContaining({ changeType: 'created' }));
  });

  it('update → update, on live rows only', async () => {
    db.dataGateway.count.mockResolvedValue(1);
    db.dataGateway.update.mockResolvedValue({ id: 'gw-1' } as DataGateway);

    await service.update('gw-1', { name: 'New' } as UpdateDataGatewayDto);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.DataGateway, Action.update);
    expect(db.dataGateway.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'gw-1', deletedAt: null, AND: [COND] }) }),
    );
  });

  // Every read already hides a tombstone, so a write that still found one would
  // re-enable, reconnect or re-delete a gateway the API says does not exist.
  it('update treats a soft-deleted gateway as not found', async () => {
    db.dataGateway.count.mockResolvedValue(0);

    await expect(service.update('gw-1', { enabled: true } as UpdateDataGatewayDto)).rejects.toThrow(NotFoundException);

    expect(db.dataGateway.count).toHaveBeenCalledWith({ where: { id: 'gw-1', deletedAt: null } });
    expect(db.dataGateway.update).not.toHaveBeenCalled();
    expect(configEvents.publish).not.toHaveBeenCalled();
  });

  it('update rejects an empty patch', async () => {
    await expect(service.update('gw-1', {} as UpdateDataGatewayDto)).rejects.toThrow(BadRequestException);
  });

  it('delete → delete (soft) and publishes a deleted event', async () => {
    db.dataGateway.count.mockResolvedValue(1);
    db.dataGateway.update.mockResolvedValue({ id: 'gw-1' } as DataGateway);

    await service.delete('gw-1');

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.DataGateway, Action.delete);
    expect(db.dataGateway.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'gw-1', deletedAt: null, AND: [COND] }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
    expect(configEvents.publish).toHaveBeenCalledWith(expect.objectContaining({ changeType: 'deleted' }));
  });

  it('delete throws NotFound for a missing gateway', async () => {
    db.dataGateway.count.mockResolvedValue(0);
    await expect(service.delete('gw-1')).rejects.toThrow(NotFoundException);
  });

  it('delete treats an already soft-deleted gateway as not found', async () => {
    db.dataGateway.count.mockResolvedValue(0);

    await expect(service.delete('gw-1')).rejects.toThrow(NotFoundException);

    expect(db.dataGateway.count).toHaveBeenCalledWith({ where: { id: 'gw-1', deletedAt: null } });
    expect(db.dataGateway.update).not.toHaveBeenCalled();
    expect(configEvents.publish).not.toHaveBeenCalled();
  });

  // The count saw a live row, but the write, which carries the caller's
  // ceiling, matched none: the ceiling excludes that gateway, or a delete
  // landed between the two statements. Either way it is a refusal naming the
  // action, and nothing is published.
  it('update refuses a live gateway its scoped write does not reach', async () => {
    db.dataGateway.count.mockResolvedValue(1);
    db.dataGateway.update.mockRejectedValue(noRowMatched());

    const refusal = service.update('gw-1', { name: 'New' } as UpdateDataGatewayDto);

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: expect.objectContaining({ key: 'common.forbidden.update' }),
    });
    expect(configEvents.publish).not.toHaveBeenCalled();
  });

  it('delete refuses a live gateway its scoped write does not reach', async () => {
    db.dataGateway.count.mockResolvedValue(1);
    db.dataGateway.update.mockRejectedValue(noRowMatched());

    const refusal = service.delete('gw-1');

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: expect.objectContaining({ key: 'common.forbidden.delete' }),
    });
    expect(configEvents.publish).not.toHaveBeenCalled();
  });

  // A 404 is the client's answer, not a server fault. Logged at error level it
  // is indistinguishable from a real defect to log-based alerting.
  describe('error logging', () => {
    let errorLog: jest.SpyInstance;

    beforeEach(() => {
      errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(() => errorLog.mockRestore());

    it('getById answers an unknown id with a 404 and no error log', async () => {
      db.dataGateway.findUniqueOrThrow.mockRejectedValue(noRowMatched());

      await expect(service.getById('gw-1')).rejects.toThrow(NotFoundException);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('update answers an unknown id with a 404 and no error log', async () => {
      db.dataGateway.count.mockResolvedValue(0);

      await expect(service.update('gw-1', { name: 'New' } as UpdateDataGatewayDto)).rejects.toThrow(NotFoundException);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('delete answers an unknown id with a 404 and no error log', async () => {
      db.dataGateway.count.mockResolvedValue(0);

      await expect(service.delete('gw-1')).rejects.toThrow(NotFoundException);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('still logs an unexpected failure at error level', async () => {
      const failure = new Error('connection reset');
      db.dataGateway.findUniqueOrThrow.mockRejectedValue(failure);

      await expect(service.getById('gw-1')).rejects.toBe(failure);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('gw-1'), failure);
    });
  });
});
