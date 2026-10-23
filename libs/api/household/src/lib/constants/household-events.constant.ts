/**
 * EventEmitter2 names for the Household aggregate.
 *
 * These are the INTERNAL domain-event names (audit + in-process listeners), not
 * webhook wire names — those live in `WebhookEventType` and are versioned
 * (`household.ownership.transferred.v1`). The two are emitted separately from
 * the same call site, mirroring the game-import processors.
 *
 * The household aggregate had no emit sites at all before #158; the rest of its
 * mutations (create/update/delete, member add/role-change/removal) are #245.
 */
export enum HouseholdEvents {
  OwnershipTransferred = 'household.ownership.transferred',
  /** A member's waiting game share approved by a household owner or admin (#810). */
  GameShareApproved = 'household.game_share.approved',
  /** A member's game share into the household ended by their leaving or removal (#810). */
  GameShareEnded = 'household.game_share.ended',
}
