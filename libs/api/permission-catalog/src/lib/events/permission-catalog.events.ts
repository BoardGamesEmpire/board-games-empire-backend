import { MutationEvent } from '@bge/actor-context';
import {
  ResourceType,
  type PermissionSnapshotRow,
  type RolePermissionSnapshotRow,
  type RoleSnapshotRow,
} from '@bge/database';
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

/** A role as the audit row records an edit to it (#772): its description, and who manages it. */
export type RoleSnapshot = Readonly<Pick<RoleSnapshotRow, 'name' | 'description' | 'managedBy'>>;

/** The Owner edited a role's description (#772). Audited by default. */
export class RoleUpdatedEvent extends MutationEvent<RoleSnapshot> {
  static readonly eventName = PermissionCatalogEvents.RoleUpdated;

  declare readonly before: RoleSnapshot;
  declare readonly after: RoleSnapshot;

  readonly subject = ResourceType.Role;

  constructor(
    /** The role row's id. The snapshots name it, which a reader knows it by. */
    readonly subjectId: string,
    before: RoleSnapshot,
    after: RoleSnapshot,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
  }
}

/** A grant as the audit row records a change to it (#772): which role holds which permission, and its state. */
export type GrantSnapshot = Readonly<
  Pick<RolePermissionSnapshotRow, 'roleName' | 'permissionSlug' | 'managedBy' | 'revokedAt'>
>;

/**
 * The Owner added a grant, gave a revoked one back, revoked one, or deleted
 * one the server doesn't ship (#772). Audited by default. `before` is null
 * when the grant was created, and `after` when it was deleted, so the audit
 * row records a create, an update or a delete.
 */
export class RolePermissionChangedEvent extends MutationEvent<GrantSnapshot> {
  static readonly eventName = PermissionCatalogEvents.RolePermissionChanged;

  readonly subject = ResourceType.RolePermission;

  constructor(
    /** The grant row's id. */
    readonly subjectId: string,
    before: GrantSnapshot | null,
    after: GrantSnapshot | null,
    initiatedAt: Date,
  ) {
    super(before, after, initiatedAt);
  }
}
