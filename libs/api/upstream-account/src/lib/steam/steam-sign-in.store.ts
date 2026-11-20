import type { Redis } from '@bge/redis';
import { CACHE_REDIS_CLIENT } from '@bge/redis';
import { Inject, Injectable } from '@nestjs/common';
import { generateRandomString } from 'better-auth/crypto';
import { z } from 'zod';

/** How long a pending Steam sign-in lasts, in minutes (#935). */
export const STEAM_SIGN_IN_LIFETIME_MINUTES = 30;

/** How long a pending Steam sign-in lasts, in milliseconds: {@link STEAM_SIGN_IN_LIFETIME_MINUTES}. */
export const STEAM_SIGN_IN_LIFETIME_MS = STEAM_SIGN_IN_LIFETIME_MINUTES * 60 * 1000;

/** Random characters in a state: 192 bits from better-auth's 64-character alphabet. */
const STATE_LENGTH = 32;

/** The alphabet `generateRandomString` draws from. Anything else is not a state we issued. */
const STATE_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{${STATE_LENGTH}}$`);

const STATE_KEY_PREFIX = 'bge:upstream-link:steam:state:';
const USER_KEY_PREFIX = 'bge:upstream-link:steam:user:';

/**
 * A Steam sign-in the server started and Steam has not yet answered (#935),
 * as the cache keeps it. A record read back is data from outside the process,
 * so it is parsed through this schema (#1322).
 */
const pendingSteamSignInSchema = z
  .object({
    /** When the sign-in started, as an ISO 8601 timestamp. */
    createdAt: z.iso.datetime(),

    /**
     * Where the client asked to be sent once the upstream account is linked:
     * an absolute http or https address, since the browser is redirected
     * there. A bare host, an IP address or a port is fine: a self-hosted
     * client often has no domain name.
     */
    returnTo: z.url({ protocol: /^https?$/ }),

    userId: z.string().min(1),
  })
  .readonly();

/** A Steam sign-in the server started and Steam has not yet answered (#935). */
export type PendingSteamSignIn = z.infer<typeof pendingSteamSignInSchema>;

/** The pending sign-in a cache record holds, or null when it holds none. */
function parsePending(raw: string): PendingSteamSignIn | null {
  let record: unknown;

  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = pendingSteamSignInSchema.safeParse(record);

  return parsed.success ? parsed.data : null;
}

/**
 * The pending Steam sign-ins (#935), in the cache Redis. The `state` is a
 * single-use secret: it travels in Steam's return address, and taking it
 * removes it. Each user has at most one live state, so starting again
 * replaces the earlier sign-in. A state lives {@link STEAM_SIGN_IN_LIFETIME_MS}.
 */
@Injectable()
export class SteamSignInStore {
  constructor(@Inject(CACHE_REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Keeps `pending` under a new state and makes it the user's only one.
   *
   * The user's pointer is swapped with one `SET … GET`, which writes the new
   * state and returns the one it displaced. Concurrent starts for a user each
   * displace a different predecessor, so each deletes the state before it and
   * only the last swap's state stays takeable, with no script or transaction.
   */
  async start(pending: Omit<PendingSteamSignIn, 'createdAt'>): Promise<{ expiresAt: Date; state: string }> {
    const state = generateRandomString(STATE_LENGTH);
    const now = Date.now();
    const record: PendingSteamSignIn = { ...pending, createdAt: new Date(now).toISOString() };

    await this.redis.set(`${STATE_KEY_PREFIX}${state}`, JSON.stringify(record), 'PX', STEAM_SIGN_IN_LIFETIME_MS);

    const previous = await this.redis.set(
      `${USER_KEY_PREFIX}${pending.userId}`,
      state,
      'PX',
      STEAM_SIGN_IN_LIFETIME_MS,
      'GET',
    );

    if (previous !== null && previous !== state) {
      await this.redis.del(`${STATE_KEY_PREFIX}${previous}`);
    }

    return { state, expiresAt: new Date(now + STEAM_SIGN_IN_LIFETIME_MS) };
  }

  /**
   * The pending sign-in `state` stands for, once. A second take, an expired or
   * unknown state, or a malformed one finds nothing.
   */
  async take(state: string): Promise<PendingSteamSignIn | null> {
    if (!STATE_PATTERN.test(state)) {
      return null;
    }

    const raw = await this.redis.getdel(`${STATE_KEY_PREFIX}${state}`);
    return raw === null ? null : parsePending(raw);
  }
}
