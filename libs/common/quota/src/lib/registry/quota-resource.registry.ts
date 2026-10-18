import { DatabaseService, InviteType, QuotaScope } from '@bge/database';
import { Injectable } from '@nestjs/common';
import type { QuotaResource } from '../constants/quota-resource';
import type { QuotaExecutor, QuotaResourceDefinition, QuotaUsageProvider } from '../interfaces';

/** How far back `household_invite_daily_count` looks. Fixed here, not set per row. */
const HOUSEHOLD_INVITE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Stateless catalogue of every quota-eligible resource. Mirrors
 * WebhookEventRegistry: a constant map, no DB. Declares per resource which
 * scopes it is measured in and how to compute current usage for a concrete
 * target.
 *
 * Resources without a `usage` provider are registered but not yet enforceable
 * — the model needed to measure them doesn't exist. They can be addressed by
 * the admin API (so caps can be pre-provisioned), but `check()` against them
 * throws (fail loudly: no write path should be calling it yet).
 */
@Injectable()
export class QuotaResourceRegistry {
  private readonly definitions: ReadonlyMap<QuotaResource, QuotaResourceDefinition> = new Map<
    QuotaResource,
    QuotaResourceDefinition
  >([
    [
      'household_member_count',
      {
        key: 'household_member_count',
        applicableScopes: [QuotaScope.Household],
        usage: this.countHouseholdMembers.bind(this),
      },
    ],
    [
      'webhook_subscription_count',
      {
        key: 'webhook_subscription_count',
        // User-scoped: WebhookSubscription.householdId is optional, createdById is not.
        applicableScopes: [QuotaScope.User],
        usage: this.countWebhookSubscriptions.bind(this),
      },
    ],
    [
      // Owner-anchored: storage is charged to MediaObject.ownerId (the controlling
      // principal — the service account once media is contributed), summed per
      // user and globally. Households are share *targets*, not owners, so storage
      // is intentionally not measured at Household scope — charging share targets
      // would double-count the same bytes.
      'storage_bytes',
      {
        key: 'storage_bytes',
        applicableScopes: [QuotaScope.Server, QuotaScope.User],
        usage: this.sumStorageBytes.bind(this),
      },
    ],
    [
      // Pending #59 (plugin loader): no install model yet.
      'plugin_install_count',
      {
        key: 'plugin_install_count',
        applicableScopes: [QuotaScope.Server, QuotaScope.Household],
      },
    ],
    [
      // A rate, measured as a count over a rolling window of 24 hours. At User
      // scope, the invites the inviter sent in it. At Household scope, the
      // invites the household made in it: one sent directly counts from when
      // it was sent, and a member's invite that waited for approval (#166)
      // counts from its approval, so the proposals an owner never approves
      // take none of the household's. The window is fixed in code; a row sets
      // only how many fit in it. A counted invite counts whatever its status
      // since, so revoking one frees no slot, and a withheld invite (#278)
      // counts like any other, so the cap cannot tell the inviter which it was.
      'household_invite_daily_count',
      {
        key: 'household_invite_daily_count',
        applicableScopes: [QuotaScope.User, QuotaScope.Household],
        usage: this.countRecentHouseholdInvites.bind(this),
      },
    ],
  ]);

  constructor(private readonly databaseService: DatabaseService) {}

  has(resource: string): resource is QuotaResource {
    return this.definitions.has(resource as QuotaResource);
  }

  /** Definition for a known resource, throwing if absent (programmer error). */
  require(resource: QuotaResource): QuotaResourceDefinition {
    const definition = this.definitions.get(resource);
    if (!definition) {
      throw new Error(`No quota resource definition registered for "${resource}"`);
    }

    return definition;
  }

  /**
   * Usage provider for an *enforceable* resource, throwing if the resource is
   * registered but not yet measurable. Use at `check()` time.
   */
  requireUsage(resource: QuotaResource): QuotaUsageProvider {
    const definition = this.require(resource);
    if (!definition.usage) {
      throw new Error(`Quota resource "${resource}" is registered but not yet enforceable (no usage provider)`);
    }

    return definition.usage;
  }

  /** Every registered resource key. */
  keys(): QuotaResource[] {
    return [...this.definitions.keys()];
  }

  private async countHouseholdMembers(_scope: QuotaScope, scopeId: string, db?: QuotaExecutor) {
    const client = db ?? this.databaseService;
    const count = await client.householdMember.count({ where: { householdId: scopeId } });
    return BigInt(count);
  }

  private async countWebhookSubscriptions(_scope: QuotaScope, scopeId: string, db?: QuotaExecutor) {
    const client = db ?? this.databaseService;
    const count = await client.webhookSubscription.count({ where: { createdById: scopeId, deletedAt: null } });
    return BigInt(count);
  }

  private async countRecentHouseholdInvites(scope: QuotaScope, scopeId: string, db?: QuotaExecutor) {
    if (scope !== QuotaScope.User && scope !== QuotaScope.Household) {
      throw new Error(`household_invite_daily_count usage is not defined for scope '${scope}'`);
    }
    const client = db ?? this.databaseService;
    const since = new Date(Date.now() - HOUSEHOLD_INVITE_WINDOW_MS);
    const count = await client.invite.count({
      where:
        scope === QuotaScope.User
          ? { type: InviteType.Household, inviterId: scopeId, createdAt: { gt: since } }
          : {
              type: InviteType.Household,
              householdId: scopeId,
              OR: [{ needsApproval: false, createdAt: { gt: since } }, { approvedAt: { gt: since } }],
            },
    });
    return BigInt(count);
  }

  private async sumStorageBytes(scope: QuotaScope, scopeId: string, db?: QuotaExecutor): Promise<bigint> {
    if (scope !== QuotaScope.Server && scope !== QuotaScope.User) {
      // storage_bytes declares only [Server, User]; a new scope must opt in here
      // explicitly rather than be silently treated as User and skew accounting.
      throw new Error(`storage_bytes usage is not defined for scope '${scope}'`);
    }
    const client = db ?? this.databaseService;
    const { _sum } = await client.mediaObject.aggregate({
      _sum: { sizeBytes: true },
      where: scope === QuotaScope.Server ? {} : { ownerId: scopeId },
    });
    return _sum?.sizeBytes ?? 0n;
  }
}
