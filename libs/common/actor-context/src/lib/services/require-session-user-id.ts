import { t } from '@bge/i18n-core';
import { ForbiddenException } from '@nestjs/common';
import { isUserActor, type Actor } from '../types';

/**
 * The acting user's id, or 403 unless the actor is a person signed in as
 * themself. For an act only the user may take in person: consenting to a
 * plugin (#322) or joining a household (#276).
 *
 * `AuditContextService.getActingUserId` answers an API key with its owner's
 * id, which is right where the key's scopes bound what it may do. Here no
 * scope does: a key acts for its owner but is not the owner, so a key of any
 * scope could otherwise take the act for them. A plugin, the system, an
 * anonymous guest and a missing actor are refused too.
 */
export function requireSessionUserId(actor: Actor | null): string {
  if (!actor || !isUserActor(actor)) {
    throw new ForbiddenException(t('common.forbidden.action'));
  }

  return actor.userId;
}
