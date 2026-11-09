import { AuditContextService } from '@bge/actor-context';
import { MODULE_OPTIONS_TOKEN, PluginGrantAuthorityService, PluginInstallAuthorityError } from '@bge/plugin';
import { PluginArchiveRefusedError, PluginArtifactTooLargeError } from '@bge/plugin-artifacts';
import { PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES } from '@boardgamesempire/plugin-manifest';
import {
  Body,
  Catch,
  Controller,
  Logger,
  Module,
  Post,
  Req,
  UseFilters,
  UseInterceptors,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MulterError } from 'multer';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginArtifactUploadInvalidError } from './plugin-artifact-upload-invalid.error';
import { PluginArtifactUploadInterceptor, transformUploadError } from './plugin-artifact-upload.interceptor';
import type { PluginArtifactUploadedFile } from './plugin-artifact-upload.storage';

const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]);

let seen: { file?: PluginArtifactUploadedFile; body?: unknown; existedInHandler?: boolean } = {};
let handlerFails = false;
let handlerReplacesFileWithDirectory = false;

class EchoFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const status = (error as { getStatus?: () => number }).getStatus?.() ?? 500;
    response.status(status).json({ name: error.name, message: error.message });
  }
}
Catch()(EchoFilter);

class UploadController {
  take(req: { file?: PluginArtifactUploadedFile }, body: unknown) {
    seen = { file: req.file, body, existedInHandler: req.file ? existsSync(req.file.path) : undefined };
    if (handlerFails) throw new Error('handler failed');
    if (handlerReplacesFileWithDirectory && req.file) {
      // A path the backstop cannot remove: rmSync refuses a directory, even as root.
      rmSync(req.file.path);
      mkdirSync(req.file.path);
      writeFileSync(join(req.file.path, 'child'), '');
    }
    return { ok: true };
  }
}

// This lib's spec tsconfig does not enable decorator syntax, so the route is
// decorated by calling the decorators.
const takeDescriptor = Object.getOwnPropertyDescriptor(UploadController.prototype, 'take') as PropertyDescriptor;
Controller('upload')(UploadController);
UseFilters(EchoFilter)(UploadController);
Post()(UploadController.prototype, 'take', takeDescriptor);
UseInterceptors(PluginArtifactUploadInterceptor)(UploadController.prototype, 'take', takeDescriptor);
Req()(UploadController.prototype, 'take', 0);
Body()(UploadController.prototype, 'take', 1);

describe('PluginArtifactUploadInterceptor (#1094)', () => {
  let app: INestApplication;
  let root: string;
  let url: string;
  let isServerAdmin: jest.Mock;
  const incoming = () => (existsSync(join(root, '.incoming')) ? readdirSync(join(root, '.incoming')) : []);

  const post = (form: FormData) => fetch(url, { method: 'POST', body: form });
  const fileForm = (bytes: Buffer, extra: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/gzip' }), 'a.tgz');
    return form;
  };

  beforeEach(async () => {
    seen = {};
    handlerFails = false;
    handlerReplacesFileWithDirectory = false;
    root = mkdtempSync(join(tmpdir(), 'bge-interceptor-'));
    isServerAdmin = jest.fn().mockResolvedValue(true);
    class TestModule {}
    Module({
      controllers: [UploadController],
      providers: [
        PluginArtifactUploadInterceptor,
        { provide: MODULE_OPTIONS_TOKEN, useValue: { pluginsRoot: root } },
        { provide: PluginGrantAuthorityService, useValue: { isServerAdmin } },
        { provide: AuditContextService, useValue: { getActingUserId: () => 'actor-1' } },
      ],
    })(TestModule);
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/upload`;
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('hands the handler the stored file, then removes it after the handler returns (#1094)', async () => {
    const response = await post(fileForm(GZIP, { expectedSha256: 'x' }));

    expect(response.status).toBe(201);
    expect(seen.file?.size).toBe(GZIP.length);
    expect(seen.file?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.existedInHandler).toBe(true);
    expect(seen.body).toEqual({ expectedSha256: 'x' });
    expect(incoming()).toEqual([]);
  });

  it('removes the file when the handler throws (#1094)', async () => {
    handlerFails = true;

    const response = await post(fileForm(GZIP));

    expect(response.status).toBe(500);
    expect(seen.existedInHandler).toBe(true);
    expect(incoming()).toEqual([]);
  });

  it('logs a file it cannot remove instead of throwing, which would end the process (#1094)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    handlerReplacesFileWithDirectory = true;

    const response = await post(fileForm(GZIP));

    expect(response.status).toBe(201);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(seen.file?.path ?? '<no file>'));
    warn.mockRestore();
  });

  it('passes bytes that are not gzip through as PluginArchiveRefusedError and leaves nothing (#1094)', async () => {
    const response = await post(fileForm(Buffer.from('PK\x03\x04')));

    expect(await response.json()).toMatchObject({ name: new PluginArchiveRefusedError('not-gzip').name });
    expect(seen.file).toBeUndefined();
    expect(incoming()).toEqual([]);
  });

  it('lets a JSON request through with no multipart body (#1094)', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ link: 'https://example.com/a.tgz' }),
    });

    expect(response.status).toBe(201);
    expect(seen.file).toBeUndefined();
    expect(seen.body).toEqual({ link: 'https://example.com/a.tgz' });
  });

  it('refuses a second file field as PluginArtifactUploadInvalidError and leaves nothing (#1094)', async () => {
    const form = fileForm(GZIP);
    form.append('other', new Blob([new Uint8Array(GZIP)]), 'b.tgz');

    const response = await post(form);

    expect(await response.json()).toMatchObject({ name: 'PluginArtifactUploadInvalidError' });
    expect(incoming()).toEqual([]);
  });

  it('refuses a user who is not a server admin before multer reads a byte, so nothing reaches .incoming (#1094)', async () => {
    isServerAdmin.mockResolvedValue(false);

    const response = await post(fileForm(GZIP, { sha256: 'x' }));

    expect(await response.json()).toMatchObject({ name: new PluginInstallAuthorityError('actor-1').name });
    expect(isServerAdmin).toHaveBeenCalledWith('actor-1');
    // The storage makes .incoming as the first byte arrives: it never ran.
    expect(existsSync(join(root, '.incoming'))).toBe(false);
    expect(seen).toEqual({});
  });

  it('refuses a JSON request from a user who is not a server admin too (#1094)', async () => {
    isServerAdmin.mockResolvedValue(false);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/a.tgz' }),
    });

    expect(await response.json()).toMatchObject({ name: 'PluginInstallAuthorityError' });
    expect(seen).toEqual({});
  });

  describe('transformUploadError', () => {
    it("maps multer's size limit to PluginArtifactTooLargeError at the production cap (#1094)", () => {
      const error = transformUploadError(new MulterError('LIMIT_FILE_SIZE', 'file'));

      expect(error).toBeInstanceOf(PluginArtifactTooLargeError);
      expect((error as PluginArtifactTooLargeError).limitBytes).toBe(PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES);
    });

    it("maps every other multer error to PluginArtifactUploadInvalidError, keeping multer's own for the log (#1094)", () => {
      const multerError = new MulterError('LIMIT_UNEXPECTED_FILE', 'other');

      const error = transformUploadError(multerError);

      expect(error).toBeInstanceOf(PluginArtifactUploadInvalidError);
      expect((error as PluginArtifactUploadInvalidError).name).toBe('PluginArtifactUploadInvalidError');
      // Multer's English message never reaches the client; the filter renders localized copy.
      expect((error as Error).message).not.toContain('Unexpected field');
      expect((error as Error).cause).toBe(multerError);
    });

    it('leaves errors from the storage engine unchanged (#1094)', () => {
      const refused = new PluginArchiveRefusedError('not-gzip');
      const tooLarge = new PluginArtifactTooLargeError(5);

      expect(transformUploadError(refused)).toBe(refused);
      expect(transformUploadError(tooLarge)).toBe(tooLarge);
    });
  });
});
