import { DatabaseService, QuotaScope } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { type QuotaResource } from '../constants/quota-resource';
import type { QuotaResourceDefinition, QuotaUsageProvider } from '../interfaces';

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
      // Pending #58 (MediaObject/StorageDriver): Media is owned by uploaderId
      // with no stable household attribution yet. Registered so caps can be set,
      // not yet enforceable. HouseholdMember scope becomes meaningful once
      // storage attribution lands.
      'storage_bytes',
      {
        key: 'storage_bytes',
        applicableScopes: [QuotaScope.Server, QuotaScope.User],
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

  private async countHouseholdMembers(_scope: QuotaScope, scopeId: string) {
    const count = await this.databaseService.householdMember.count({ where: { householdId: scopeId } });
    return BigInt(count);
  }

  private async countWebhookSubscriptions(_scope: QuotaScope, scopeId: string) {
    const count = await this.databaseService.webhookSubscription.count({
      where: { createdById: scopeId, deletedAt: null },
    });
    return BigInt(count);
  }
}
