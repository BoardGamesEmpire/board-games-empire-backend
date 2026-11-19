/**
 * EventEmitter2 names for the Household aggregate.
 *
 * These are the INTERNAL domain event names (audit + in-process listeners), not
 * webhook wire names — those live in `WebhookEventType` and are versioned
 * (`household.ownership.transferred.v1`). The two are emitted separately from
 * the same call site, mirroring the game-import processors.
 *
 * Every household change has a domain event here (#245), emitted after commit
 * through `HouseholdEventPublisher`, which also emits the change's webhook
 * event type when it has one.
 */
export enum HouseholdEvents {
  OwnershipTransferred = 'household.ownership.transferred',
  /** A member's waiting game share approved by a household owner or admin (#810). */
  GameShareApproved = 'household.game_share.approved',
  /** A member's game share into the household ended by their leaving or removal (#810). */
  GameShareEnded = 'household.game_share.ended',
  /** A household created, on a fresh create only, never a replayed one (#210, #245). */
  Created = 'household.created',
  /** A household's columns or settings edited; only those that changed are recorded (#245). */
  Updated = 'household.updated',
  /** A household soft-deleted (#245). */
  Deleted = 'household.deleted',
  /** A soft-deleted household restored (#245). */
  Restored = 'household.restored',
  /** A user admitted to the household (#245). */
  MemberAdded = 'household.member.added',
  /** A member's household role changed (#245). */
  MemberRoleChanged = 'household.member.role_changed',
  /** A membership ended: the member left, was removed from the household or was banned (#245). */
  MemberRemoved = 'household.member.removed',
  /** A user banned from the household (#782, #245). */
  BanCreated = 'household.ban.created',
  /** A ban's reason changed (#782, #245). */
  BanUpdated = 'household.ban.updated',
  /** A ban lifted (#782, #245). */
  BanLifted = 'household.ban.lifted',
}
