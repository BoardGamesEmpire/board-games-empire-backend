import { t } from '@bge/i18n';
import { UnsupportedMediaTypeException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES } from '../media-mime.policy';

export const MediaFileInterceptor = FileInterceptor('file', {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req: unknown, file: { mimetype: string }, cb: (error: Error | null, acceptFile: boolean) => void) =>
    ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new UnsupportedMediaTypeException(t('errors.media_object.unsupported_type', { mimeType: file.mimetype })), false),
});
