/**
 * Any better-auth session envelope — the `{ user, session }` pair returned by
 * `getSession`.
 *
 * The session row is deliberately `unknown`: the admin plugin's
 * `impersonatedBy` column is absent from the Nest adapter's unparameterized
 * `UserSession` type, and `@bge/utils` sits below the auth lib and must not
 * depend on it to learn the field. Narrowing it here rather than in the
 * signature keeps that one unavoidable widening in a single documented place
 * instead of a cast at every call site.
 */
export interface SessionEnvelope {
  readonly session?: unknown;
}

interface ImpersonatableSessionRow {
  readonly impersonatedBy?: string | null;
}

/**
 * Stands in for the impersonating admin's id when the session is marked as
 * impersonated but carries no usable id.
 *
 * Callers treat the return value as truthy-means-refuse, so an unusable value
 * must NOT collapse to `null` — that would admit the session. It reaches the
 * logs, never a response body.
 */
export const UNKNOWN_IMPERSONATOR = '<unknown>';

/**
 * The id of the admin behind an impersonated session, or `null` for an
 * ordinary one.
 *
 * better-auth's admin plugin mints an impersonation session with
 * `impersonatedBy` set to the acting admin's id (`/admin/impersonate-user`).
 * Every actor seam must refuse such a session rather than mint an actor from
 * `session.user`: every `AuditLog` row written under it would name the
 * impersonated user with no trace of the admin behind it — `actor`,
 * `actorKind` and `actorUserId` would all describe the target (#408).
 *
 * **Presence of the field is the marker, not its content.** Only
 * `/admin/impersonate-user` ever writes this column, so anything other than
 * SQL `NULL` means an impersonation session, including an empty string that no
 * legitimate path produces. Reading `''` as "not impersonated" would fail
 * *open* at all three actor seams, which is the one direction this guard must
 * never fail; such a value yields {@link UNKNOWN_IMPERSONATOR} instead.
 *
 * Impersonation is blocked at the admin plugin's role map, so this returns
 * `null` for every session the system can currently create. It exists so that
 * whoever unblocks impersonation walks into a refusal and has to decide how it
 * is audited first.
 */
export function sessionImpersonatorId(session: SessionEnvelope | null | undefined): string | null {
  const row = session?.session as ImpersonatableSessionRow | null | undefined;
  const impersonatedBy = row?.impersonatedBy;

  if (impersonatedBy === null || impersonatedBy === undefined) {
    return null;
  }

  return impersonatedBy || UNKNOWN_IMPERSONATOR;
}
