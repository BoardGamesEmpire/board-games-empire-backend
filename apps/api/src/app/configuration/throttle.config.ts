import { env } from '@bge/env';
import { registerAs } from '@nestjs/config';
import { seconds } from '@nestjs/throttler';
import Joi from 'joi';

/**
 * Global rate-limit window and ceiling.
 *
 * `ttlMs` is MILLISECONDS, and the name says so on purpose: `@nestjs/throttler`
 * has read `ttl` in milliseconds since v5, and a bare `60` fed to it is a 60ms
 * window rather than the minute it reads as (#293). Nothing converts between
 * units anywhere on this path — the variable, this namespace, and the throttler
 * option are all the same unit, so there is no boundary left for the two
 * readings to disagree across.
 *
 * `seconds(60)` is the library's own helper and evaluates to 60_000. It is
 * spelled that way rather than as a literal because "sixty seconds" is the
 * intent; the value is milliseconds either way.
 *
 * The ceiling is per ROUTE per IP, not a single budget per IP: `ThrottlerGuard`
 * hashes the controller and handler name into the storage key, so every
 * endpoint carries its own count. Sizing this as though a page load's worth of
 * calls came out of one bucket over-provisions every endpoint at once.
 *
 * Defaults live here rather than on the Joi schema, matching the convention
 * `plugins.config.spec.ts` states: defaulting is `@bge/env`'s job, validation
 * is Joi's. Two defaults for one key is how they drift — and Joi's would win
 * silently, since `ConfigModule` writes validated values into `process.env`
 * before these factories ever run.
 */
export default registerAs('throttle', () =>
  env.provideMany<{ ttlMs: number; limit: number }>([
    {
      keyTo: 'ttlMs',
      defaultValue: seconds(60),
      mutators: [(value: string) => parseInt(value, 10)],
      key: 'THROTTLE_TTL_MS',
    },
    {
      keyTo: 'limit',
      defaultValue: 20,
      mutators: [(value: string) => parseInt(value, 10)],
      key: 'THROTTLE_LIMIT',
    },
  ]),
);

export const throttleConfigValidationSchema = {
  // `.min(seconds(1))` is the guard that makes the rename safe rather than
  // merely tidy: someone migrating a stale `THROTTLE_TTL=60` onto the new key
  // gets a boot failure naming the unit, instead of the silent 60ms window
  // this issue exists to remove (#293).
  THROTTLE_TTL_MS: Joi.number()
    .integer()
    .min(seconds(1))
    .description(
      'Rate-limit window in MILLISECONDS. 60000 is one minute. Values under 1000 are rejected as a unit mistake.',
    ),
  THROTTLE_LIMIT: Joi.number()
    .integer()
    .min(1)
    .description(
      'Requests allowed per route, per IP, within one THROTTLE_TTL_MS window. Must be at least 1: the guard reads 0 as "reject everything".',
    ),
};
