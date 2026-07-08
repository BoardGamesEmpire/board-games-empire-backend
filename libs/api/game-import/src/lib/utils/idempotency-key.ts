/**
 * Builds a `Job.idempotencyKey` value by joining its parts with `:`. Generic:
 * each producer chooses the parts. The import path namespaces by batch and by
 * role so a base and an expansion sharing an externalId (self-referential data,
 * or a gateway echoing the base id into its expansion list) can't collide onto
 * one row:
 *
 *   base       → idempotencyKeyFor(batchId, 'base', externalId)
 *   expansion  → idempotencyKeyFor(batchId, 'exp', externalId)
 *
 * Namespacing by batch also means re-importing the same game in a later batch
 * is not treated as a duplicate, while a retry within the same batch is.
 */
export function idempotencyKeyFor(...parts: string[]): string {
  return parts.join(':');
}
