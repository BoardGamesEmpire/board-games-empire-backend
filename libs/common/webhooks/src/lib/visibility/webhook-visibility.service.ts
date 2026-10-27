import { Action, DatabaseService, ResourceType } from '@bge/database';
import type { AppAbility, ModelResourceType } from '@bge/permissions';
import { accessibleBy } from '@casl/prisma';
import { Injectable } from '@nestjs/common';

/** What a check asks beyond the row itself. */
export interface WebhookVisibilityOptions {
  /** The action every ability must hold on the row. `read` when omitted. */
  readonly action?: Action;

  /**
   * The subject was soft-deleted before its event fired, so the check reads the
   * deleted row rather than refusing it. Set from the descriptor of an event
   * that fires after the delete; a subscription's own checks never set it.
   */
  readonly subjectDeleted?: boolean;
}

/**
 * Runs the visibility count for one subject and reduces it to a boolean. Each
 * entry in {@link WebhookVisibilityService.checks} is one of these, closed over
 * its concrete Prisma delegate so the compiler still type-checks every branch.
 */
type VisibilityCheck = (
  subjectId: string,
  abilities: readonly AppAbility[],
  options: Required<WebhookVisibilityOptions>,
) => Promise<boolean>;

/**
 * Decides whether a subscriber may receive an event about a given subject
 * instance, by asking the exact same question the REST path asks: does a row
 * with this id exist that is `accessibleBy` the subscriber's ability, for the
 * action the event requires?
 *
 * A subscriber can hold several abilities, as a request through an API key
 * holds its owner's and the key's, and the row must be reachable by every one
 * of them (#723).
 *
 * This is the whole point of the CASL-at-dispatch design — webhook audience is
 * never a parallel rule set, it is live authorization. As the rules tighten
 * (game visibility, event participation, #87 ban enforcement), webhook
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
    // Event and Game are soft-deleted — a tombstoned row is visible only to an
    // event that fires after its subject's delete (`subjectDeleted`).
    [
      ResourceType.Event,
      (id, abilities, options) =>
        this.exists(this.db.event.count({ where: this.scope(ResourceType.Event, id, abilities, true, options) })),
    ],
    [
      ResourceType.Game,
      (id, abilities, options) =>
        this.exists(this.db.game.count({ where: this.scope(ResourceType.Game, id, abilities, true, options) })),
    ],
    // The base User role's `read:job` reaches import jobs only (#479): they
    // describe public content (mirroring the ImportActivity feed), so a
    // Job-subject subscription legitimately observes every user's import
    // lifecycle. The rule's `type` condition reaches this count through
    // `accessibleBy`, so a job of any other type is invisible here until the
    // catalog makes it readable. Job has no soft-delete column, hence no
    // `deletedAt` guard.
    [
      ResourceType.Job,
      (id, abilities, options) =>
        this.exists(this.db.job.count({ where: this.scope(ResourceType.Job, id, abilities, false, options) })),
    ],
    // Required by `household.ownership.transferred.v1` (#158). Without an entry
    // here `isVisibleTo` throws for the subject, `fanOut` catches it per
    // subscription, and the event is registered-but-undeliverable — an ERROR log
    // per subscriber and no delivery. Household is soft-deleted, so a
    // tombstoned household is never visible.
    [
      ResourceType.Household,
      (id, abilities, options) =>
        this.exists(
          this.db.household.count({ where: this.scope(ResourceType.Household, id, abilities, true, options) }),
        ),
    ],
  ]);

  /**
   * Whether every one of `abilities` can take the action on the subject row.
   * An empty list throws rather than answer: a count over an empty `AND`
   * matches every row, so it would pass a subscriber who holds nothing (#723).
   */
  async isVisibleTo(
    subject: ResourceType,
    subjectId: string,
    abilities: readonly AppAbility[],
    { action = Action.read, subjectDeleted = false }: WebhookVisibilityOptions = {},
  ): Promise<boolean> {
    if (abilities.length === 0) {
      throw new Error('isVisibleTo needs at least one ability');
    }

    const check = this.checks.get(subject);
    if (!check) {
      throw new Error(`No webhook visibility check implemented for subject "${subject}"`);
    }

    return check(subjectId, abilities, { action, subjectDeleted });
  }

  /**
   * The count `where` every subject shares: this id, `accessibleBy` each
   * ability for the action, and — for soft-deletable subjects — not
   * tombstoned, unless the event fired after the delete. Built with the
   * concrete subject literal so `.ofType` types the CASL clause precisely.
   */
  private scope<TResource extends ModelResourceType>(
    subject: TResource,
    id: string,
    abilities: readonly AppAbility[],
    softDelete: boolean,
    { action, subjectDeleted }: Required<WebhookVisibilityOptions>,
  ) {
    return {
      id,
      ...(softDelete && !subjectDeleted ? { deletedAt: null } : {}),
      AND: abilities.map((ability) => accessibleBy(ability, action).ofType(subject)),
    };
  }

  private async exists(count: Promise<number>): Promise<boolean> {
    return (await count) > 0;
  }
}
