/**
 * Builds a `Job.idempotencyKey` value by joining its parts with `:`. Generic:
 * each producer chooses the parts. The import path namespaces by batch and by
 * job origin so a requested game, a chosen expansion and an added base game
 * sharing an externalId (self-referential data, or a gateway echoing the
 * requested id into its expansion list) can't collide onto one row:
 *
 *   requested game   → idempotencyKeyFor(batchId, 'base', externalId)
 *   chosen expansion → idempotencyKeyFor(batchId, 'exp', externalId)
 *   added base game  → idempotencyKeyFor(batchId, 'added-base', externalId)
 *
 * An added base game has one row per batch however many games need it, and
 * none when the batch already imports it under either other origin (#971).
 *
 * Namespacing by batch also means re-importing the same game in a later batch
 * is not treated as a duplicate, while a retry within the same batch is.
 */
export function idempotencyKeyFor(...parts: string[]): string {
  return parts.join(':');
}
