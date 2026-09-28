import { t } from '@bge/i18n';
import { ForbiddenException } from '@nestjs/common';
import type { AbilityService } from '../ability.service';

/**
 * The acting user's id, for a read whose intrinsic scope is "things belonging
 * to me" — or a 403 for an actor kind that has no user behind it.
 *
 * The rejection is the intended answer, not a gap. "My households" has no
 * meaning for an actor with no user, and it must never soften into an empty
 * page: an empty page tells a client its memberships were removed, which is a
 * different and much more damaging claim than "you cannot ask this".
 *
 * PROVISIONAL, and centralized here for exactly that reason. `plugin`,
 * `system` and `external` actors are refused today because polymorphic actor
 * attribution does not exist yet (deferred to 59), not because anyone decided
 * memberships are meaningless for them — a plugin may legitimately act on a
 * user's behalf. 395 revisits it, along with anonymous actors, who could reach
 * household-adjacent access through a game play session or event.
 *
 * Without this helper that provisional answer would be copied endpoint by
 * endpoint as the sweep proceeds (418), turning a deferred question into a
 * settled pattern by repetition. Revisiting it should be one edit, not fifteen.
 *
 * The message is replaced rather than passed through: `getActingUserId`
 * phrases its rejection as being about user-attributed WRITES — accurate for
 * its usual callers, wrong on a GET. A MISSING
 * actor is a different failure (a plain `Error`: nothing primed the context)
 * and is left to propagate as the 500 it is.
 */
export function resolveScopeSubjectId(abilityService: AbilityService): string {
  const userId = resolveActingUserIdOrNull(abilityService);

  if (userId === null) {
    throw new ForbiddenException(t('common.forbidden.access'));
  }

  return userId;
}

/**
 * The acting user's id, or `null` for an actor kind with no user behind it.
 *
 * For an operation that goes ahead either way and only changes shape when a
 * user is acting: a household delete gives its owners an undo only when one
 * of them deleted it (175). It draws the same provisional line as
 * {@link resolveScopeSubjectId}, which is built on it, so revisiting which
 * actor kinds have a user (395) moves both answers at once.
 *
 * A MISSING actor is not a userless one, and propagates as the 500 it is.
 */
export function resolveActingUserIdOrNull(abilityService: AbilityService): string | null {
  try {
    return abilityService.getActingUserId();
  } catch (error) {
    if (error instanceof ForbiddenException) {
      return null;
    }

    throw error;
  }
}
