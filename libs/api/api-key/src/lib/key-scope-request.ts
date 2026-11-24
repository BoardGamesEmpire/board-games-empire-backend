import type { Permission } from '@bge/database';
import { ResourceType, RiskLevel } from '@bge/database';
import type { UserWithRoles } from '@bge/permissions';
import { acceptsPin, grantablePermissions, mayKeyHold } from '@bge/permissions';
import { API_KEY_EXPIRY_MAX_DAYS, API_KEY_EXPIRY_MIN_DAYS } from './api-key.constants';
import {
  criticalNeedsConfirmation,
  expiryOutOfRange,
  needsRecentSignIn,
  scopeNotGrantable,
  scopeNotPinnable,
} from './api-key.errors';

const DAY_MS = 24 * 60 * 60 * 1000;

const RESOURCE_TYPES: ReadonlySet<string> = new Set<string>(Object.values(ResourceType));

/** One key scope a create or edit request names: a permission's slug, pinned to one row when `resourceId` is given. */
export interface RequestedScope {
  readonly resourceId?: string;
  readonly slug: string;
}

/** A requested key scope checked against its owner and resolved to the row a key scope is written as (#1418). */
export interface ResolvedScope {
  readonly permissionId: string;

  /** The pinned row, or `null` for a key scope over every row its owner's ability reaches. */
  readonly resourceId: string | null;

  /** The permission's subject; a permission on `all` never resolves. */
  readonly resourceType: ResourceType;

  readonly riskLevel: RiskLevel;
  readonly slug: string;
}

/** The permissions that aren't retired, keyed by slug, with the columns a key scope needs. */
export type ScopeCatalog = ReadonlyMap<string, Pick<Permission, 'action' | 'id' | 'riskLevel' | 'slug' | 'subject'>>;

/**
 * Checks each requested key scope against its owner, in request order, and
 * resolves it to its permission (#1418). It refuses, naming the slug:
 *
 * - a slug the catalog lacks, a permission on `all`, and one the owner's key
 *   may not hold ({@link mayKeyHold}), as not grantable;
 * - a pin on a permission that accepts none ({@link acceptsPin}), as not
 *   pinnable.
 *
 * A pinned row isn't looked up: a key is judged by its owner's ability and its
 * own together, so a pin on a row the owner can't reach reaches nothing.
 *
 * The same permission requested twice with the same pin, or twice unpinned,
 * is one key scope; the first is kept. An unpinned key scope beside a pinned
 * one over the same permission keeps both.
 */
export function resolveRequestedScopes(
  owner: UserWithRoles,
  catalog: ScopeCatalog,
  requested: readonly RequestedScope[],
): ResolvedScope[] {
  const resolved: ResolvedScope[] = [];
  const seen = new Map<string, Set<string | null>>();

  for (const { slug, resourceId: pin } of requested) {
    const permission = catalog.get(slug);
    const resourceId = pin ?? null;

    // `all` isn't a ResourceType, so this check refuses it and narrows the subject.
    if (!permission || !isResourceType(permission.subject) || !mayKeyHold(owner, permission.id)) {
      throw scopeNotGrantable(slug);
    }

    if (resourceId !== null && !acceptsPin(permission)) {
      throw scopeNotPinnable(slug);
    }

    const pins = seen.get(permission.id) ?? new Set<string | null>();
    if (pins.has(resourceId)) {
      continue;
    }

    pins.add(resourceId);
    seen.set(permission.id, pins);
    resolved.push({
      permissionId: permission.id,
      slug: permission.slug,
      resourceType: permission.subject,
      resourceId,
      riskLevel: permission.riskLevel,
    });
  }

  return resolved;
}

/**
 * The "everything I can do" preset: one unpinned key scope per permission the
 * owner's key may hold, in {@link grantablePermissions} order (#1418). A
 * permission the catalog no longer holds is left out: a cached graph can still
 * carry one retired since it was read.
 */
export function everythingScopes(owner: UserWithRoles, catalog: ScopeCatalog): ResolvedScope[] {
  return grantablePermissions(owner).flatMap(({ slug }): ResolvedScope[] => {
    const permission = catalog.get(slug);

    if (!permission || !isResourceType(permission.subject)) {
      return [];
    }

    return [
      {
        permissionId: permission.id,
        slug: permission.slug,
        resourceType: permission.subject,
        resourceId: null,
        riskLevel: permission.riskLevel,
      },
    ];
  });
}

/**
 * Whether `next` gives the key a Critical permission it doesn't hold yet
 * (#1418). An edit passes the permissions the key holds now, so keeping a
 * Critical permission asks for nothing again; a create passes an empty set.
 */
export function addsCritical(next: readonly ResolvedScope[], currentPermissionIds: ReadonlySet<string>): boolean {
  return next.some(
    ({ permissionId, riskLevel }) => riskLevel === RiskLevel.Critical && !currentPermissionIds.has(permissionId),
  );
}

/**
 * Giving a key a Critical permission it doesn't hold yet needs the owner's
 * confirmation and a recent sign-in, checked in that order, so a client asks
 * the owner before sending them to sign in again (#1418).
 *
 * Freshness is better-auth's rule, as the provider link check applies it: a
 * `freshAgeSeconds` of 0 checks nothing, and a session signed in
 * `freshAgeSeconds` ago or longer is stale. An unknown sign-in time is stale.
 */
export function assertCriticalAllowed(input: {
  addsCritical: boolean;
  confirmed: boolean;
  freshAgeSeconds: number;
  now: number;
  signedInAt: Date | null;
}): void {
  if (!input.addsCritical) {
    return;
  }

  if (!input.confirmed) {
    throw criticalNeedsConfirmation();
  }

  if (isStale(input.signedInAt, input.now, input.freshAgeSeconds)) {
    throw needsRecentSignIn();
  }
}

/**
 * The expiry `expiresInDays` from `now` (#1418). It refuses a count outside 1
 * to 365 days; a request that names none passes the default itself. It accepts
 * a fraction: the request DTO refuses a non-integer before it gets here.
 */
export function expiryDate(expiresInDays: number, now: number): Date {
  const inRange = expiresInDays >= API_KEY_EXPIRY_MIN_DAYS && expiresInDays <= API_KEY_EXPIRY_MAX_DAYS;

  if (!inRange) {
    throw expiryOutOfRange();
  }

  return new Date(now + expiresInDays * DAY_MS);
}

function isResourceType(subject: string): subject is ResourceType {
  return RESOURCE_TYPES.has(subject);
}

function isStale(signedInAt: Date | null, now: number, freshAgeSeconds: number): boolean {
  if (freshAgeSeconds === 0) {
    return false;
  }

  if (signedInAt === null) {
    return true;
  }

  return now - signedInAt.getTime() >= freshAgeSeconds * 1000;
}
