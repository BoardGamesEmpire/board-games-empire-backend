import { Prisma } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SystemSettingsView } from './read-shapes';
import { SystemSettingsService } from './system-settings.service';

const recordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Record to update not found', { code: 'P2025', clientVersion: 'test' });

const settings = { id: 'settings-1', name: 'Board Games Empire' } as SystemSettingsView;

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;
  let db: MockDatabaseService;

  beforeEach(async () => {
    const ctx = await createTestingModuleWithDb({
      providers: [
        SystemSettingsService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn(), getOrThrow: jest.fn() },
        },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(SystemSettingsService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });

  describe('getSystemSettings', () => {
    it('returns the one settings row', async () => {
      db.systemSetting.findMany.mockResolvedValue([settings] as never);

      await expect(service.getSystemSettings()).resolves.toBe(settings);
    });

    it('answers 404 when there is no settings row', async () => {
      db.systemSetting.findMany.mockResolvedValue([]);

      await expect(service.getSystemSettings()).rejects.toThrow(NotFoundException);
    });

    it('answers 409 when there is more than one settings row', async () => {
      db.systemSetting.findMany.mockResolvedValue([settings, { ...settings, id: 'settings-2' }] as never);

      await expect(service.getSystemSettings()).rejects.toThrow(ConflictException);
    });
  });

  describe('updateSystemSettings', () => {
    it('returns the row as written', async () => {
      db.systemSetting.update.mockResolvedValue(settings as never);

      await expect(service.updateSystemSettings('settings-1', { name: 'Board Games Empire' })).resolves.toBe(settings);
    });

    it('answers 404 naming the id when no row has it', async () => {
      db.systemSetting.update.mockRejectedValue(recordNotFound());

      await expect(service.updateSystemSettings('missing', {})).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
        response: expect.objectContaining({ key: 'errors.system_settings.id_not_found', args: { id: 'missing' } }),
      });
    });

    it('rethrows any other database error unchanged', async () => {
      // Only the missing row is a 404. Anything else must still surface as
      // itself rather than read as an unknown id.
      const failure = new Error('connection lost');
      db.systemSetting.update.mockRejectedValue(failure);

      await expect(service.updateSystemSettings('settings-1', {})).rejects.toBe(failure);
    });
  });
});
