import { MutationEvent } from '@bge/actor-context';
import { ResourceType, type PermissionSnapshotRow } from '@bge/database';
import { PermissionCatalogEvents } from '../constants/permission-catalog-events.constant';

/**
 * A permission as the audit row records an edit to it (#772): the columns the
 * Owner can change, and who maintains the row, which every edit sets to the
 * Owner.
 */
export type PermissionSnapshot = Readonly<
  Pick<PermissionSnapshotRow, 'slug' | 'conditions' | 'reason' | 'riskLevel' | 'managedBy' | 'retiredAt'>
>;

/**
 * The Owner edited a permission (#772). Audited by default, like every
 * mutation event: the actor comes from CLS when the audit listener handles it.
 */
export class PermissionUpdatedEvent extends MutationEvent<PermissionSnapshot> {
  static readonly eventName = PermissionCatalogEvents.PermissionUpdated;

  declare readonly before: PermissionSnapshot;
  declare readonly after: PermissionSnapshot;

  readonly subject = ResourceType.Permission;

  constructor(
    /** The permission row's id. The snapshots name it by slug, which a reader knows it by. */
    readonly subjectId: string,
    before: PermissionSnapshot,
    after: PermissionSnapshot,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
  }
}
