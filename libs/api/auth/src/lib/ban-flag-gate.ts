import type { I18nPath } from '@bge/i18n';
import { APIError } from 'better-auth/api';

export const BAN_FLAG_INVALID = 'BAN_FLAG_INVALID';

const MESSAGE: I18nPath = 'errors.auth.ban_flag_invalid';

export interface BanFlagGate {
  /**
   * Called from `databaseHooks.user.create.before` and `update.before` with
   * the fields about to be written. Throws when `banned` is among them and is
   * neither `true` nor `false`.
   */
  check(data: { readonly [field: string]: unknown }): void;
}

/**
 * Refuses a user write whose ban flag isn't `true` or `false`, with 400 and a
 * BGE code (#893).
 *
 * better-auth's admin create-user and update-user pass their `data` to the
 * database without checking its values: they check only that the actor may
 * ban. A NULL flag once got through that way, and readers disagreed on it: a
 * user it touched could still sign in, but search never found them and their
 * profile answered 404 to everyone. The column now refuses NULL, so the
 * mistake is caught here and answered as the actor's, with nothing written.
 * It is never turned into `false`, which would lift a ban over what is
 * probably a typo.
 *
 * A missing flag, or one left `undefined`, writes nothing, so it passes: a
 * new user gets the column's default, and an update keeps the flag it has.
 *
 * The message is rendered in the fallback locale, as the settings gates' are:
 * `/api/auth/*` runs ahead of Nest's i18n.
 */
export function createBanFlagGate(render: (key: I18nPath) => string): BanFlagGate {
  return {
    check(data) {
      const banned = data['banned'];
      if (banned === undefined || typeof banned === 'boolean') {
        return;
      }

      throw new APIError('BAD_REQUEST', { code: BAN_FLAG_INVALID, message: render(MESSAGE) });
    },
  };
}
