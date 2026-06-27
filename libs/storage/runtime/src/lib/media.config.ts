import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export interface MediaConfig {
  /**
   * Active storage driver slug. v1 supports 'localdisk' only.
   */
  driver: string;

  /**
   * Filesystem root for LocalDiskDriver.
   */
  localDiskRoot: string;

  /**
   * Absolute base URL the streaming controller is reachable at (no trailing slash).
   */
  baseUrl: string;

  /**
   * Path of the internal streaming route signed GET URLs point at.
   */
  streamPath: string;
}

export const mediaConfig = registerAs('media', () =>
  env.provideMany<MediaConfig>([
    { keyTo: 'driver', key: 'MEDIA_STORAGE_DRIVER', defaultValue: 'localdisk' },
    { keyTo: 'localDiskRoot', key: 'MEDIA_LOCAL_DISK_ROOT', defaultValue: '/var/lib/bge/media' },
    { keyTo: 'baseUrl', key: 'MEDIA_BASE_URL', defaultValue: 'http://localhost:3000' },
    { keyTo: 'streamPath', key: 'MEDIA_STREAM_PATH', defaultValue: '/media/stream' },
  ]),
);

export const mediaConfigValidationSchema = {
  MEDIA_STORAGE_DRIVER: Joi.string().valid('localdisk').default('localdisk'),
  MEDIA_LOCAL_DISK_ROOT: Joi.string().default('/var/lib/bge/media'),
  MEDIA_BASE_URL: Joi.string().uri().default('http://localhost:3000'),
  MEDIA_STREAM_PATH: Joi.string().default('/media/stream'),
};
