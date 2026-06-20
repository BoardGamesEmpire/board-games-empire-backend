import { Action, EventOccurrence, OccurrenceStatus, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventOccurrenceService } from './event-occurrence.service';

const COND = { id: 'sentinel-condition' };

describe('EventOccurrenceService', () => {
  let service: EventOccurrenceService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockReturnValue([COND]);

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventOccurrenceService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventOccurrenceService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('getOccurrences', () => {
    it('filters by read conditions and scopes to the event', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventOccurrence.findMany.mockResolvedValue([]);

      await service.getOccurrences('event-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.read,
      );
      expect(db.eventOccurrence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ eventId: 'event-1', AND: [COND] }) }),
      );
    });

    it('throws NotFound when the event does not exist', async () => {
      db.event.count.mockResolvedValue(0);
      await expect(service.getOccurrences('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getOccurrence', () => {
    it('filters by read conditions', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.getOccurrence('event-1', 'occ-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.read,
      );
      expect(db.eventOccurrence.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'occ-1', AND: [COND] }) }),
      );
    });

    it('throws NotFound when the occurrence is not visible', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventOccurrence.findUnique.mockResolvedValue(null);
      await expect(service.getOccurrence('event-1', 'occ-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateOccurrence', () => {
    it('filters by UPDATE conditions (tightened from read)', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);
      db.eventOccurrence.update.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.updateOccurrence('event-1', 'occ-1', { label: 'x' });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.update,
      );
      expect(db.eventOccurrence.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'occ-1', AND: [COND] }) }),
      );
    });

    it('rejects an empty patch', async () => {
      await expect(service.updateOccurrence('event-1', 'occ-1', {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('removeOccurrence', () => {
    it('filters by DELETE conditions', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);
      db.eventOccurrence.delete.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.removeOccurrence('event-1', 'occ-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.delete,
      );
    });
  });

  describe('status transitions', () => {
    it('confirmOccurrence filters by UPDATE conditions', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({
        id: 'occ-1',
        status: OccurrenceStatus.Proposed,
      } as EventOccurrence);
      db.eventOccurrence.update.mockResolvedValue({ id: 'occ-1' } as EventOccurrence);

      await service.confirmOccurrence('event-1', 'occ-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.update,
      );
    });

    it('rejects an illegal source status', async () => {
      db.eventOccurrence.findUnique.mockResolvedValue({
        id: 'occ-1',
        status: OccurrenceStatus.Confirmed,
      } as EventOccurrence);
      await expect(service.confirmOccurrence('event-1', 'occ-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('getAvailabilitySummary', () => {
    it('filters occurrences by read conditions', async () => {
      db.event.count.mockResolvedValue(1);
      db.eventAttendee.findMany.mockResolvedValue([]);
      db.eventOccurrence.findMany.mockResolvedValue([]);

      await service.getAvailabilitySummary('event-1');

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.EventOccurrence,
        Action.read,
      );
    });
  });

  it('propagates the ForbiddenException raised on empty conditions', async () => {
    db.event.count.mockResolvedValue(1);
    abilityService.getCurrentResourceConditions.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(service.getOccurrences('event-1')).rejects.toThrow(ForbiddenException);
  });
});
