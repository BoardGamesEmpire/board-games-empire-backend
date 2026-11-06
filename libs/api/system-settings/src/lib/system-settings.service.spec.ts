import { Prisma } from '@bge/database';
import { MailDispatcherService, MailQueueUnavailableError } from '@bge/queue-mail';
import { EncryptionService } from '@bge/services';
import { createTestingModuleWithDb, rawQueryText, unwrapTransaction, type MockDatabaseService } from '@bge/testing';
import { ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { SystemSettingsView } from './read-shapes';
import { SystemSettingsService } from './system-settings.service';

const recordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Record to update not found', { code: 'P2025', clientVersion: 'test' });

const settings = { id: 'settings-1', name: 'Board Games Empire' } as SystemSettingsView;
const stored = { ...settings, smtpPassword: null };

describe('SystemSettingsService', () => {
  let service: SystemSettingsService;
  let db: MockDatabaseService;
  const encryption = { encrypt: jest.fn((value: string) => `enc(${value})`), decrypt: jest.fn() };
  const dispatcher = { enqueue: jest.fn() };

  beforeEach(async () => {
    const ctx = await createTestingModuleWithDb({
      providers: [
        SystemSettingsService,
        { provide: EncryptionService, useValue: encryption },
        { provide: MailDispatcherService, useValue: dispatcher },
      ],
    });

    dispatcher.enqueue.mockReset().mockResolvedValue(undefined);

    db = ctx.db;
    service = ctx.module.get(SystemSettingsService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });

  describe('getSystemSettings', () => {
    it('returns the one settings row', async () => {
      db.systemSetting.findMany.mockResolvedValue([stored] as never);

      await expect(service.getSystemSettings()).resolves.toEqual({ ...settings, smtpPasswordSet: false });
    });

    it('answers 404 when there is no settings row', async () => {
      db.systemSetting.findMany.mockResolvedValue([]);

      await expect(service.getSystemSettings()).rejects.toThrow(NotFoundException);
    });

    it('answers 409 when there is more than one settings row', async () => {
      db.systemSetting.findMany.mockResolvedValue([stored, { ...stored, id: 'settings-2' }] as never);

      await expect(service.getSystemSettings()).rejects.toThrow(ConflictException);
    });
  });

  describe('updateSystemSettings', () => {
    beforeEach(() => {
      unwrapTransaction(db);
    });

    it('returns the row as written', async () => {
      db.systemSetting.update.mockResolvedValue(stored as never);

      await expect(service.updateSystemSettings('settings-1', { name: 'Board Games Empire' })).resolves.toEqual({
        ...settings,
        smtpPasswordSet: false,
      });
    });

    describe('smtpPassword (#654)', () => {
      const dataOf = () => (db.systemSetting.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;

      beforeEach(() => {
        db.systemSetting.update.mockResolvedValue({ ...stored, smtpPassword: 'enc(s3cret)' } as never);
      });

      it('writes the encrypted password, never the plaintext (#654)', async () => {
        await service.updateSystemSettings('settings-1', { smtpPassword: 's3cret' });

        expect(dataOf().smtpPassword).toBe('enc(s3cret)');
      });

      it('writes null to clear it (#654)', async () => {
        await service.updateSystemSettings('settings-1', { smtpPassword: null });

        expect(dataOf().smtpPassword).toBeNull();
      });

      it('leaves the column out of the write when the patch omits it (#654)', async () => {
        await service.updateSystemSettings('settings-1', { name: 'x' });

        expect(dataOf()).not.toHaveProperty('smtpPassword');
      });

      it('returns whether one is set, never the password or its ciphertext (#654)', async () => {
        const result = await service.updateSystemSettings('settings-1', { smtpPassword: 's3cret' });

        expect(result.smtpPasswordSet).toBe(true);
        expect(result).not.toHaveProperty('smtpPassword');
      });

      it('maps a stored ciphertext to smtpPasswordSet on read (#654)', async () => {
        db.systemSetting.findMany.mockResolvedValue([{ ...stored, smtpPassword: 'enc(x)' }] as never);

        const result = await service.getSystemSettings();

        expect(result.smtpPasswordSet).toBe(true);
        expect(result).not.toHaveProperty('smtpPassword');
      });
    });

    // Keeping the stored password while the server changes would send it to
    // whatever server the editor names, which reads it back (#654).
    describe('a change of SMTP server while a password is stored (#654)', () => {
      const server = { smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'StartTls', smtpPassword: 'enc(x)' };

      beforeEach(() => {
        db.systemSetting.findUnique.mockResolvedValue(server as never);
        db.systemSetting.update.mockResolvedValue(stored as never);
      });

      it.each([
        ['host', { smtpHost: 'attacker.example' }],
        ['port', { smtpPort: 2525 }],
        ['connection security', { smtpSecurity: 'None' as const }],
      ])('refuses a new %s that keeps the password, writing nothing (#654)', async (_name, update) => {
        await expect(service.updateSystemSettings('settings-1', update as never)).rejects.toMatchObject({
          status: HttpStatus.BAD_REQUEST,
          response: {
            code: 'SMTP_PASSWORD_REQUIRED',
            message: expect.objectContaining({ key: 'errors.system_settings.smtp_password_required' }),
          },
        });
        expect(db.systemSetting.update).not.toHaveBeenCalled();
      });

      it.each([
        ['sends the password again', { smtpHost: 'smtp2.example.com', smtpPassword: 'n3w' }],
        ['clears the password', { smtpHost: 'smtp2.example.com', smtpPassword: null }],
        ['clears the host, so nothing is sent', { smtpHost: null }],
        ['repeats the stored server', { smtpHost: 'smtp.example.com', smtpPort: 587, smtpSecurity: 'StartTls' }],
      ])('allows a change that %s (#654)', async (_name, update) => {
        await expect(service.updateSystemSettings('settings-1', update as never)).resolves.toBeDefined();
        expect(db.systemSetting.update).toHaveBeenCalledTimes(1);
      });

      it('allows a new server when no password is stored (#654)', async () => {
        db.systemSetting.findUnique.mockResolvedValue({ ...server, smtpPassword: null } as never);

        await expect(
          service.updateSystemSettings('settings-1', { smtpHost: 'smtp2.example.com' }),
        ).resolves.toBeDefined();
      });

      it('reads nothing when the patch leaves the server alone (#654)', async () => {
        await service.updateSystemSettings('settings-1', { smtpUser: 'bge' });

        expect(db.systemSetting.findUnique).not.toHaveBeenCalled();
        expect(db.$queryRaw).not.toHaveBeenCalled();
      });

      // A password saved between the check and the write would otherwise be
      // kept for the server this patch names (#654).
      it('locks the row before the check, and checks and writes in one transaction (#654)', async () => {
        const order: string[] = [];
        db.$queryRaw.mockImplementation(((query: unknown) => {
          order.push(rawQueryText(query));
          return Promise.resolve([]);
        }) as never);
        db.systemSetting.findUnique.mockImplementation((() => {
          order.push('check');
          return Promise.resolve({ ...server, smtpPassword: null });
        }) as never);
        db.systemSetting.update.mockImplementation((() => {
          order.push('write');
          return Promise.resolve(stored);
        }) as never);

        await service.updateSystemSettings('settings-1', { smtpHost: 'smtp2.example.com' });

        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['SELECT id FROM system_settings WHERE id = ? FOR UPDATE', 'check', 'write']);
      });
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

  describe('sendTestMail (#654)', () => {
    const configured = { smtpHost: 'smtp.example.com', mailFromAddress: 'bge@example.com' };

    it('reads only the singleton row, and only what the configured check needs (#654)', async () => {
      db.systemSetting.findUnique.mockResolvedValue(configured as never);

      await service.sendTestMail('user-1');

      expect(db.systemSetting.findUnique).toHaveBeenCalledWith({
        where: { singleton: true },
        select: { smtpHost: true, mailFromAddress: true },
      });
    });

    it('queues a test email for the recipient when mail is set up (#654)', async () => {
      db.systemSetting.findUnique.mockResolvedValue(configured as never);

      await service.sendTestMail('user-1');

      expect(dispatcher.enqueue).toHaveBeenCalledWith('user-1', { kind: 'test' });
    });

    it('answers 409 MAIL_NOT_CONFIGURED and queues nothing when mail is not set up (#654)', async () => {
      db.systemSetting.findUnique.mockResolvedValue({ smtpHost: null, mailFromAddress: null } as never);

      await expect(service.sendTestMail('user-1')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: {
          code: 'MAIL_NOT_CONFIGURED',
          message: expect.objectContaining({ key: 'errors.system_settings.mail_not_configured' }),
        },
      });
      expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('answers 503 MAIL_QUEUE_UNAVAILABLE at once while the queue is down (#654)', async () => {
      db.systemSetting.findUnique.mockResolvedValue(configured as never);
      dispatcher.enqueue.mockRejectedValue(new MailQueueUnavailableError());

      await expect(service.sendTestMail('user-1')).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        response: {
          code: 'MAIL_QUEUE_UNAVAILABLE',
          message: expect.objectContaining({ key: 'errors.system_settings.mail_queue_unavailable' }),
        },
      });
    });

    it('lets any other queue failure propagate, so the admin hears the test failed (#654)', async () => {
      db.systemSetting.findUnique.mockResolvedValue(configured as never);
      const failure = new Error('redis down');
      dispatcher.enqueue.mockRejectedValue(failure);

      await expect(service.sendTestMail('user-1')).rejects.toBe(failure);
    });
  });
});
