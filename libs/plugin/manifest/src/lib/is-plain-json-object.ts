/**
 * Answers whether a stored or parsed JSON value is a plain object: non-null
 * and not an array. A `Json` column admits arrays, `null` and scalars, so every
 * site that judges a retained configuration must agree on what counts as a
 * document; one definition keeps them from drifting apart (#393).
 */
export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
