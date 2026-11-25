import { AuditContextService } from '@bge/actor-context';
import { AuthService, SESSION_FRESH_AGE_SECONDS } from '@bge/auth';
import { DatabaseService, Prisma } from '@bge/database';
import type { GrantablePermission, UserWithRoles } from '@bge/permissions';
import { grantablePermissions, PermissionsService } from '@bge/permissions';
import type { PaginatedRows, ResolvedPaging } from '@bge/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { ApiKeyPreset } from './api-key.constants';
import { API_KEY_EXPIRY_DEFAULT_DAYS } from './api-key.constants';
import { apiKeyNotFound, scopesOrPreset } from './api-key.errors';
import type { RequestedScope, ResolvedScope, ScopeCatalog } from './key-scope-request';
import {
  addsCritical,
  assertCriticalAllowed,
  assertExpiryInRange,
  everythingScopes,
  expiryDate,
  resolveRequestedScopes,
} from './key-scope-request';

const DAY_SECONDS = 24 * 60 * 60;

/** One key scope as a key's owner reads it: the permission's slug, and the pinned row or `null`. */
export interface ApiKeyScopeView {
  readonly resourceId: string | null;
  readonly slug: string;
}

/** An API key as its owner reads it (#1418). The secret is never part of it. */
export interface ApiKeyView {
  readonly createdAt: Date;

  /** `false` only once the owner disables the key; a key whose flag was never set is enabled. */
  readonly enabled: boolean;

  readonly expiresAt: Date | null;
  readonly id: string;

  /** When the key last authenticated a request, or `null` if it never has. */
  readonly lastUsedAt: Date | null;

  readonly name: string | null;
  readonly scopes: ApiKeyScopeView[];

  /** The secret's first characters, so the owner can tell keys apart. */
  readonly start: string | null;
}

/** A key the calling key reads about itself, with the whole seconds left until it expires (#1418). */
export interface CurrentApiKeyView extends ApiKeyView {
  /** `null` for a key with no expiry; 0 once it has passed. */
  readonly secondsRemaining: number | null;
}

/** A key just created, with its secret: the one time the secret can be read (#1418). */
export interface CreatedApiKeyView {
  readonly apiKey: ApiKeyView;
  readonly secret: string;
}

/** What a create names (#1418). With neither `scopes` nor `preset`, the key holds no key scopes. */
export interface ApiKeyCreateInput {
  /** Confirms a Critical permission the key would hold. */
  readonly confirmCritical?: boolean;

  /** Whole days from now, 1 to 365; 90 when left out. */
  readonly expiresInDays?: number;

  readonly name: string;

  /** "Everything I can do": every permission the owner's key may hold, unpinned. */
  readonly preset?: ApiKeyPreset;

  readonly scopes?: readonly RequestedScope[];
}

/** What an edit names (#1418). A field left out stays as it is; `scopes` replaces the whole list. */
export interface ApiKeyUpdateInput {
  /** Confirms a Critical permission the edit adds. */
  readonly confirmCritical?: boolean;

  readonly enabled?: boolean;

  /** Whole days from now, 1 to 365, earlier or later than the expiry the key has. */
  readonly expiresInDays?: number;

  readonly name?: string;
  readonly scopes?: readonly RequestedScope[];
}

/** The columns an {@link ApiKeyView} is built from. */
const API_KEY_VIEW_SELECT = {
  id: true,
  name: true,
  start: true,
  expiresAt: true,
  enabled: true,
  lastRequest: true,
  createdAt: true,
  scopes: {
    // A key scope over a retired permission confers nothing (#235), and an
    // edit can't name one again, so the owner isn't shown it.
    where: { permission: { retiredAt: null } },
    orderBy: [{ permission: { slug: 'asc' } }, { resourceId: { sort: 'asc', nulls: 'first' } }],
    select: { resourceId: true, permission: { select: { slug: true } } },
  },
} satisfies Prisma.ApikeySelect;

type ApiKeyRow = Prisma.ApikeyGetPayload<{ select: typeof API_KEY_VIEW_SELECT }>;

/** The permission columns a requested key scope is checked and written with. */
const SCOPE_CATALOG_SELECT = {
  id: true,
  slug: true,
  action: true,
  subject: true,
  riskLevel: true,
} satisfies Prisma.PermissionSelect;

/**
 * A user's own API keys (#1417, #1418): what a key may hold, and creating,
 * reading, editing and deleting keys. Every method but {@link current} acts
 * for `userId`, the signed-in owner, and answers another user's key as it
 * answers a missing one.
 *
 * Only create goes through better-auth, which makes and hashes the secret.
 * An edit and a delete write the `apikeys` row with Prisma: the key plugin
 * keeps keys in the database and reads the row on every check, so a disabled
 * or expired key is refused on its next request.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  /** The clock, in epoch milliseconds; a spec replaces it. */
  private readonly now = (): number => Date.now();

  constructor(
    private readonly permissions: PermissionsService,
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly auditContext: AuditContextService,
  ) {}

  /**
   * The permissions `userId`'s API key may hold, sorted by slug (#1417). The
   * graph is the one every request's ability is built from, so the list shows
   * what the owner holds now. A user with no graph, such as one deleted a
   * moment ago, gets an empty list.
   */
  async grantableFor(userId: string): Promise<GrantablePermission[]> {
    const graph = await this.permissions.getUserRoleGraph(userId);

    return graph ? grantablePermissions(graph) : [];
  }

  /**
   * Creates a key for `userId` and answers it with its secret (#1418).
   *
   * Every check runs before anything is written: key scopes, pins, the
   * expiry and the Critical rule. better-auth then writes the key through its
   * own adapter, outside any Prisma transaction, and the key scopes follow in
   * a transaction of their own. If that transaction fails, the key is deleted
   * and the failure rethrown. A crash between the two leaves a key with no
   * key scope rows: it is denied everywhere, and its owner can delete it from
   * the list.
   */
  async create(userId: string, input: ApiKeyCreateInput): Promise<CreatedApiKeyView> {
    if (input.scopes !== undefined && input.preset !== undefined) {
      throw scopesOrPreset();
    }

    const [owner, catalog] = await Promise.all([this.ownerGraph(userId), this.scopeCatalog()]);
    const resolved =
      input.preset === 'everything' ? everythingScopes(owner, catalog) : this.resolve(owner, catalog, input.scopes);
    const expiresInDays = input.expiresInDays ?? API_KEY_EXPIRY_DEFAULT_DAYS;
    // Only the range check: better-auth works out the expiry itself from the seconds.
    assertExpiryInRange(expiresInDays);
    this.checkCritical(addsCritical(resolved, new Set()), input.confirmCritical);

    const created = await this.auth.createApiKey({
      userId,
      name: input.name,
      expiresInSeconds: expiresInDays * DAY_SECONDS,
    });

    let row: ApiKeyRow;
    let replaced: boolean;
    try {
      [row, replaced] = await this.db.$transaction(async (tx) => {
        // The key is listed from the moment better-auth writes it, so its owner
        // can edit or delete it before this transaction runs. The row lock
        // orders this write after any such edit, as two edits are ordered.
        const locked = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT id FROM apikeys WHERE id = ${created.id} FOR UPDATE`,
        );

        if (locked.length === 0) {
          throw apiKeyNotFound();
        }

        // An edit that got in first wrote key scopes of its own. Create's list
        // replaces them, as a later edit's would, rather than merging with them.
        const { count } = await tx.apiKeyScope.deleteMany({ where: { apiKeyId: created.id } });
        await tx.apiKeyScope.createMany({ data: resolved.map((scope) => scopeRow(created.id, scope)) });

        return [
          await tx.apikey.findUniqueOrThrow({ where: { id: created.id }, select: API_KEY_VIEW_SELECT }),
          count > 0,
        ];
      });
    } catch (error) {
      await this.deleteUnscopedKey(created.id);

      throw error;
    }

    // A request through the key may have cached the earlier edit's key scopes.
    if (replaced) {
      await this.permissions.invalidateApiKey(created.id);
    }

    return { apiKey: toView(row), secret: created.key };
  }

  /** One page of `userId`'s keys, newest first, and how many they hold (#1418). */
  async list(userId: string, { page, pageSize }: ResolvedPaging): Promise<PaginatedRows<ApiKeyView>> {
    const where = { referenceId: userId } satisfies Prisma.ApikeyWhereInput;

    // One snapshot, so a key created or deleted meanwhile can't make the total disagree with the rows.
    const [rows, total] = await this.db.$transaction(
      [
        this.db.apikey.findMany({
          where,
          // Two keys created in the same millisecond still page in one order.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: API_KEY_VIEW_SELECT,
        }),
        this.db.apikey.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: rows.map(toView), total };
  }

  /** `userId`'s key `id`. Another user's key answers `API_KEY_NOT_FOUND`, as a missing one does (#1418). */
  async get(userId: string, id: string): Promise<ApiKeyView> {
    const row = await this.db.apikey.findUnique({ where: { id, referenceId: userId }, select: API_KEY_VIEW_SELECT });

    if (!row) {
      throw apiKeyNotFound();
    }

    return toView(row);
  }

  /**
   * Edits `userId`'s key `id` (#1418). An edit that names none of `name`,
   * `scopes`, `expiresInDays` or `enabled` changes nothing: it answers the key
   * as it is, and evicts nothing.
   *
   * The expiry is checked before the transaction. Inside it the key's row is
   * locked first, so two edits at once can't merge their key scope lists, and
   * an edit and a delete can't interleave. The key scopes it holds are read
   * under that lock, so a Critical permission it keeps asks for nothing,
   * while one it adds needs a confirmation and a recent sign-in. Extending
   * the expiry or enabling the key asks for nothing either, even for a key
   * that holds a Critical permission: the owner confirmed that permission
   * when the key was given it, and neither edit adds a permission.
   *
   * The key's cached scope graph is evicted after the commit when the key
   * scopes or the enabled flag were given. A name or an expiry needs no
   * eviction: better-auth reads the row on every request, so it refuses a key
   * past its new expiry, and the cached scope graph is built from the key
   * scopes alone.
   */
  async update(userId: string, id: string, input: ApiKeyUpdateInput): Promise<ApiKeyView> {
    const { name, scopes, expiresInDays, enabled, confirmCritical } = input;

    if (name === undefined && scopes === undefined && expiresInDays === undefined && enabled === undefined) {
      return this.get(userId, id);
    }

    const expiresAt = expiresInDays === undefined ? undefined : expiryDate(expiresInDays, this.now());
    const replacement =
      scopes === undefined ? undefined : await Promise.all([this.ownerGraph(userId), this.scopeCatalog()]);

    const row = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM apikeys WHERE id = ${id} AND reference_id = ${userId} FOR UPDATE`,
      );

      if (locked.length === 0) {
        throw apiKeyNotFound();
      }

      if (replacement !== undefined) {
        const [owner, catalog] = replacement;
        const resolved = this.resolve(owner, catalog, scopes);
        const held = await tx.apiKeyScope.findMany({ where: { apiKeyId: id }, select: { permissionId: true } });
        this.checkCritical(
          addsCritical(resolved, new Set(held.map(({ permissionId }) => permissionId))),
          confirmCritical,
        );

        await tx.apiKeyScope.deleteMany({ where: { apiKeyId: id } });
        await tx.apiKeyScope.createMany({ data: resolved.map((scope) => scopeRow(id, scope)) });
      }

      return tx.apikey.update({ where: { id }, data: { name, expiresAt, enabled }, select: API_KEY_VIEW_SELECT });
    });

    if (scopes !== undefined || enabled !== undefined) {
      await this.permissions.invalidateApiKey(id);
    }

    return toView(row);
  }

  /**
   * Deletes `userId`'s key `id`, with its key scopes, and evicts its cached
   * scope graph (#1418). Another user's key answers `API_KEY_NOT_FOUND`, as a
   * missing one does, and evicts nothing.
   */
  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.db.apikey.deleteMany({ where: { id, referenceId: userId } });

    if (count === 0) {
      throw apiKeyNotFound();
    }

    await this.permissions.invalidateApiKey(id);
  }

  /**
   * The calling key, read by its own id, with the whole seconds left until it
   * expires, worked out by the server so a client with a wrong clock reads
   * them right (#1418). A key deleted since it was checked answers
   * `API_KEY_NOT_FOUND`.
   */
  async current(apiKeyId: string): Promise<CurrentApiKeyView> {
    const row = await this.db.apikey.findUnique({ where: { id: apiKeyId }, select: API_KEY_VIEW_SELECT });

    if (!row) {
      throw apiKeyNotFound();
    }

    const view = toView(row);
    const secondsRemaining =
      view.expiresAt === null ? null : Math.max(0, Math.floor((view.expiresAt.getTime() - this.now()) / 1000));

    return { ...view, secondsRemaining };
  }

  /** The owner's graph; a user with none, such as one deleted a moment ago, holds nothing a key could. */
  private async ownerGraph(userId: string): Promise<UserWithRoles> {
    const graph = await this.permissions.getUserRoleGraph(userId);

    return graph ?? { id: userId, roles: [], householdMember: [], eventsAttended: [], permissions: [] };
  }

  /** The permissions that aren't retired, keyed by slug. */
  private async scopeCatalog(): Promise<ScopeCatalog> {
    const permissions = await this.db.permission.findMany({
      where: { retiredAt: null },
      select: SCOPE_CATALOG_SELECT,
    });

    return new Map(permissions.map((permission) => [permission.slug, permission]));
  }

  private resolve(
    owner: UserWithRoles,
    catalog: ScopeCatalog,
    scopes: readonly RequestedScope[] | undefined,
  ): ResolvedScope[] {
    return scopes === undefined ? [] : resolveRequestedScopes(owner, catalog, scopes);
  }

  /** {@link assertCriticalAllowed} with the actor's sign-in time, by better-auth's fresh-session age. */
  private checkCritical(adds: boolean, confirmCritical: boolean | undefined): void {
    assertCriticalAllowed({
      addsCritical: adds,
      confirmed: confirmCritical === true,
      freshAgeSeconds: SESSION_FRESH_AGE_SECONDS,
      now: this.now(),
      signedInAt: this.auditContext.getSessionSignedInAt(),
    });
  }

  /**
   * Deletes a key whose key scopes could not be written (#1418). By id through
   * Prisma, since better-auth's delete reads a session. A failure here is
   * logged, not thrown, so `create` rethrows the failure that caused it: the
   * key left behind holds no key scopes, so it is denied everywhere.
   */
  private async deleteUnscopedKey(id: string): Promise<void> {
    try {
      await this.db.apikey.deleteMany({ where: { id } });
    } catch (error) {
      this.logger.error(
        `Could not delete API key ${id}, left with no key scopes after its key scope write failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

function scopeRow(
  apiKeyId: string,
  { permissionId, resourceType, resourceId }: ResolvedScope,
): Prisma.ApiKeyScopeCreateManyInput {
  return { apiKeyId, permissionId, resourceType, resourceId };
}

function toView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    start: row.start,
    scopes: row.scopes.map(({ resourceId, permission }) => ({ slug: permission.slug, resourceId })),
    expiresAt: row.expiresAt,
    enabled: row.enabled ?? true,
    lastUsedAt: row.lastRequest,
    createdAt: row.createdAt,
  };
}
