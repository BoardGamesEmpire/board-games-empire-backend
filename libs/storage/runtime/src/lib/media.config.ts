import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';

const DEFAULT_MEDIA_TTL_SECONDS = 300; // 5 minutes
const DEFAULT_PROBE_TIMEOUT_MS = 5000; // 5s — bounds a hung stat (unreachable NFS) so readiness fails fast
const DEFAULT_PROBE_TIMEOUT_FATAL_THRESHOLD = 3; // consecutive probe timeouts before the process self-exits
const DEFAULT_SENTINEL_FILE = '.bge-storage-sentinel';

/**
 * Strategy for detecting a runtime volume unmount on `LocalDiskDriver` (a clean
 * `umount` leaves the mountpoint directory in place, so a naive `stat` can't tell
 * a live mount from a detached one). See the runtime README for the tradeoffs.
 *
 * - `auto`     — use `st_dev` only when the root is its own mount; otherwise a
 *                no-op. Best zero-config default for dedicated block volumes/PVs
 *                and local dev.
 * - `st_dev`   — always compare the root's device id against a boot baseline.
 * - `sentinel` — require an operator-provisioned marker file under the root.
 *                Robust where `st_dev` is unreliable (NFS remount, overlay, bind).
 * - `off`      — no unmount detection (today's behavior).
 */
export type MountCheckMode = 'auto' | 'st_dev' | 'sentinel' | 'off';

export interface MediaConfig {
  /**
   * Active storage driver slug. v1 supports 'localdisk' only.
   */
  driver: string;

  /**
   * Filesystem root for LocalDiskDriver.
   */
  localDiskRoot: string;

  /** Default TTL for minted signed GET URLs. Keep short — leaked URLs expire fast. */
  signedUrlTtlSeconds: number;

  /**
   * Absolute base URL the streaming controller is reachable at (no trailing slash).
   */
  baseUrl: string;

  /**
   * Path of the internal streaming route signed GET URLs point at.
   */
  streamPath: string;

  /**
   * Runtime unmount-detection strategy for LocalDiskDriver. Boot-time only — the
   * baseline it captures must not change under a running process (a reloaded
   * baseline could be captured against a detached volume and silently disable the
   * guard). See {@link MountCheckMode}.
   */
  mountCheck: MountCheckMode;

  /**
   * Sentinel marker filename, resolved under `localDiskRoot`. Used only when
   * `mountCheck` is `sentinel`.
   */
  sentinelFile: string;

  /**
   * Upper bound (ms) on a single storage reachability probe. A probe that
   * exceeds it is treated as a retryable outage — bounds a hung `stat` on an
   * unreachable NFS mount so readiness can fail instead of blocking.
   */
  probeTimeoutMs: number;

  /**
   * Number of consecutive probe timeouts after which the process self-exits so
   * the orchestrator restarts it and clears the (likely exhausted) libuv
   * threadpool. `0` disables the watchdog. See the runtime README.
   */
  probeTimeoutFatalThreshold: number;
}

export const mediaConfig = registerAs('media', () =>
  env.provideMany<MediaConfig>([
    { keyTo: 'driver', key: 'MEDIA_STORAGE_DRIVER', defaultValue: 'localdisk' },
    {
      keyTo: 'localDiskRoot',
      key: 'MEDIA_LOCAL_DISK_ROOT',
      defaultsFor: {
        production: '/var/lib/bge/media',
        development: '/tmp',
      },
    },
    {
      keyTo: 'signedUrlTtlSeconds',
      key: 'MEDIA_SIGNED_URL_TTL_SECONDS',
      mutators: (v: unknown) => Number(v),
      defaultValue: DEFAULT_MEDIA_TTL_SECONDS,
    },
    { keyTo: 'baseUrl', key: 'MEDIA_BASE_URL', defaultValue: 'http://localhost:3000' },
    { keyTo: 'streamPath', key: 'MEDIA_STREAM_PATH', defaultValue: '/media-stream' },
    {
      keyTo: 'mountCheck',
      key: 'MEDIA_LOCAL_DISK_MOUNT_CHECK',
      mutators: (v: unknown) => String(v) as MountCheckMode,
      defaultValue: 'auto',
    },
    { keyTo: 'sentinelFile', key: 'MEDIA_LOCAL_DISK_SENTINEL_FILE', defaultValue: DEFAULT_SENTINEL_FILE },
    {
      keyTo: 'probeTimeoutMs',
      key: 'MEDIA_LOCAL_DISK_PROBE_TIMEOUT_MS',
      mutators: (v: unknown) => Number(v),
      defaultValue: DEFAULT_PROBE_TIMEOUT_MS,
    },
    {
      keyTo: 'probeTimeoutFatalThreshold',
      key: 'MEDIA_LOCAL_DISK_PROBE_TIMEOUT_FATAL_THRESHOLD',
      mutators: (v: unknown) => Number(v),
      defaultValue: DEFAULT_PROBE_TIMEOUT_FATAL_THRESHOLD,
    },
  ]),
);

export const mediaConfigValidationSchema = {
  MEDIA_STORAGE_DRIVER: Joi.string().valid('localdisk').default('localdisk'),
  MEDIA_LOCAL_DISK_ROOT: Joi.string(),
  MEDIA_SIGNED_URL_TTL_SECONDS: Joi.number().integer().positive().default(DEFAULT_MEDIA_TTL_SECONDS),
  MEDIA_BASE_URL: Joi.string().uri().default('http://localhost:3000'),
  MEDIA_STREAM_PATH: Joi.string().default('/media-stream'),
  MEDIA_LOCAL_DISK_MOUNT_CHECK: Joi.string().valid('auto', 'st_dev', 'sentinel', 'off').default('auto'),
  MEDIA_LOCAL_DISK_SENTINEL_FILE: Joi.string()
    .pattern(/^[^/\\]+$/, 'bare filename (no path separators)')
    .invalid('.', '..')
    .default(DEFAULT_SENTINEL_FILE),
  MEDIA_LOCAL_DISK_PROBE_TIMEOUT_MS: Joi.number().integer().positive().default(DEFAULT_PROBE_TIMEOUT_MS),
  MEDIA_LOCAL_DISK_PROBE_TIMEOUT_FATAL_THRESHOLD: Joi.number()
    .integer()
    .min(0)
    .default(DEFAULT_PROBE_TIMEOUT_FATAL_THRESHOLD),
};
