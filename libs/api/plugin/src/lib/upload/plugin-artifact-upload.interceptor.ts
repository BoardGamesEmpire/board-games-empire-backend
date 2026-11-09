import { AuditContextService } from '@bge/actor-context';
import {
  MODULE_OPTIONS_TOKEN,
  PluginGrantAuthorityService,
  PluginInstallAuthorityError,
  type PluginModuleOptions,
} from '@bge/plugin';
import { PluginArtifactTooLargeError } from '@bge/plugin-artifacts';
import { PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES } from '@boardgamesempire/plugin-manifest';
import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import multer, { MulterError } from 'multer';
import { rmSync } from 'node:fs';
import { finalize, type Observable } from 'rxjs';
import { PluginArtifactUploadInvalidError } from './plugin-artifact-upload-invalid.error';
import { PluginArtifactUploadStorage, type PluginArtifactUploadedFile } from './plugin-artifact-upload.storage';

const UPLOAD_FIELD = 'file';

/**
 * Multer's own size limit can fire before the storage's counter does (the
 * limit is one byte over the cap), so it maps to the same domain error. Every
 * other multer error is a malformed request, which the exception filter
 * answers with localized copy and a stable code; multer's English message
 * stays on the cause, for the log. Errors from the storage engine pass
 * through unchanged.
 */
export const transformUploadError = (error: unknown): unknown => {
  if (!(error instanceof MulterError)) {
    return error;
  }

  if (error.code === 'LIMIT_FILE_SIZE') {
    return new PluginArtifactTooLargeError(PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES);
  }

  return new PluginArtifactUploadInvalidError({ cause: error });
};

/**
 * Runs multer with `PluginArtifactUploadStorage` ahead of the handler (#1094),
 * so an uploaded plugin artifact streams to the plugins volume and the handler
 * finds it at `req.file`. A request with no multipart body (a link posted as
 * JSON) passes through untouched. Built here, not through `FileInterceptor`,
 * because the storage needs the configured plugins root from DI.
 *
 * The actor must be a server admin before multer reads a byte, so nobody else
 * can stream up to 100 MiB onto the plugins volume. A JSON request meets the
 * same check, and the receiver checks again.
 *
 * Whatever the handler's outcome, the interceptor removes the file afterwards.
 * The receiver usually has already; this is the backstop. It runs before the
 * response goes out, and a file it cannot remove is logged and left in
 * `.incoming`: an error thrown from `finalize` reaches no filter, and RxJS
 * rethrows it outside the request, which ends the process.
 */
@Injectable()
export class PluginArtifactUploadInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PluginArtifactUploadInterceptor.name);
  private readonly upload: ReturnType<ReturnType<typeof multer>['single']>;

  constructor(
    @Inject(MODULE_OPTIONS_TOKEN) options: PluginModuleOptions,
    private readonly authority: PluginGrantAuthorityService,
    private readonly auditContext: AuditContextService,
  ) {
    this.upload = multer({
      storage: new PluginArtifactUploadStorage(options.pluginsRoot),
      limits: { files: 1, fields: 4, fileSize: PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES + 1 },
    }).single(UPLOAD_FIELD);
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const actorId = this.auditContext.getActingUserId();
    if (!(await this.authority.isServerAdmin(actorId))) {
      throw new PluginInstallAuthorityError(actorId);
    }

    const http = context.switchToHttp();
    const request = http.getRequest<{ file?: PluginArtifactUploadedFile }>();

    await new Promise<void>((resolve, reject) =>
      this.upload(request as never, http.getResponse(), (error: unknown) =>
        error ? reject(transformUploadError(error)) : resolve(),
      ),
    );

    return next.handle().pipe(finalize(() => this.removeUpload(request.file)));
  }

  private removeUpload(file: PluginArtifactUploadedFile | undefined): void {
    if (file === undefined) {
      return;
    }

    try {
      rmSync(file.path, { force: true });
    } catch (err) {
      this.logger.warn(
        `The uploaded plugin artifact at ${file.path} could not be removed and stays in .incoming: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
