import type { Actor } from '@bge/actor-context';
import { sessionUserId } from '@bge/actor-context';
import type { Upstream } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';
import { UpstreamAccountErrorCode } from './upstream-account.constants';

/**
 * The id of the user linking an account at `upstream`, or 403
 * `UPSTREAM_LINK_SESSION_REQUIRED` unless the actor is a registered user in
 * their own session (#935). An API key acts for its owner but is not
 * the owner, and a Steam sign-in's return finds the user again only by the
 * browser's session. The code tells this refusal apart from a missing
 * permission.
 */
export function linkingUserId(actor: Actor | null, upstream: Upstream): string {
  const userId = sessionUserId(actor);
  if (userId === null) {
    throw new CodedHttpException(
      Http.Forbidden,
      UpstreamAccountErrorCode.SessionRequired,
      t('errors.upstream_account.session_required', { upstream }),
    );
  }

  return userId;
}
