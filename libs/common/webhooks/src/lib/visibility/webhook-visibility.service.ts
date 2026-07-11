import { DatabaseService, ResourceType } from '@bge/database';
import type { AppAbility, ModelResourceType } from '@bge/permissions';
import { accessibleBy } from '@casl/prisma';
import { Injectable } from '@nestjs/common';

/**
 * Runs the visibility count for one subject and reduces it to a boolean. Each
 * entry in {@link WebhookVisibilityService.checks} is one of these, closed over
 * its concrete Prisma delegate so the compiler still type-checks every branch.
 */
type VisibilityCheck = (subjectId: string, ability: AppAbility) => Promise<boolean>;

/**
 * Decides whether a subscriber may receive an event about a given subject
 * instance, by asking the exact same question the REST read path asks: does a
 * row with this id exist that is `accessibleBy` the subscriber's ability?
 *
 * This is the whole point of the CASL-at-dispatch design — webhook audience is
 * never a parallel rule set, it is live read-authorization. As the read rules
 * tighten (game visibility, event participation, #87 ban enforcement), webhook
 * audiences narrow automatically with zero changes here.
 */
@Injectable()
export class WebhookVisibilityService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * subject → its visibility count. Replaces the former per-subject `switch` of
   * structurally identical count queries, where a new subject meant editing the
   * switch (or it threw at dispatch). Each entry is a small closure over its
   * concrete Prisma delegate, so — mirroring `QuotaResourceRegistry`'s usage
   * providers — every branch stays fully typed while the shared query shape
   * lives once in {@link scope}. An unmapped subject still fails loudly, and a
   * new subject is a single data-only line here.
   *
   * `this.db` is only dereferenced when a check runs (well after construction),
   * so referencing it from these field-level closures is safe.
   */
  private readonly checks: ReadonlyMap<ResourceType, VisibilityCheck> = new Map<ResourceType, VisibilityCheck>([
    // Event and Game are soft-deleted — a tombstoned row is never visible.
    [
      ResourceType.Event,
      (id, ability) => this.exists(this.db.event.count({ where: this.scope(ResourceType.Event, id, ability, true) })),
    ],
    [
      ResourceType.Game,
      (id, ability) => this.exists(this.db.game.count({ where: this.scope(ResourceType.Game, id, ability, true) })),
    ],
    // read:job is seeded unconditionally on the base User role by design —
    // import jobs describe public content (mirroring the ImportActivity feed),
    // so a Job-subject subscription legitimately observes every user's import
    // lifecycle. Job has no soft-delete column, hence no `deletedAt` guard. If
    // job types with private payloads land later, scope the seed (or add a
    // conditional rule) and this check tightens automatically.
    [
      ResourceType.Job,
      (id, ability) => this.exists(this.db.job.count({ where: this.scope(ResourceType.Job, id, ability, false) })),
    ],
  ]);

  async isVisibleTo(subject: ResourceType, subjectId: string, ability: AppAbility): Promise<boolean> {
    const check = this.checks.get(subject);
    if (!check) {
      throw new Error(`No webhook visibility check implemented for subject "${subject}"`);
    }

    return check(subjectId, ability);
  }

  /**
   * The count `where` every subject shares: this id, `accessibleBy` the
   * ability, and — for soft-deletable subjects — not tombstoned. Built with the
   * concrete subject literal so `.ofType` types the CASL clause precisely.
   */
  private scope<TResource extends ModelResourceType>(
    subject: TResource,
    id: string,
    ability: AppAbility,
    softDelete: boolean,
  ) {
    return {
      id,
      ...(softDelete ? { deletedAt: null } : {}),
      AND: [accessibleBy(ability).ofType(subject)],
    };
  }

  private async exists(count: Promise<number>): Promise<boolean> {
    return (await count) > 0;
  }
}
