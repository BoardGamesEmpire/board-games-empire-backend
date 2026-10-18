/**
 * The keys of a patch that name a value. A key present but `undefined` means
 * "not provided": it changes nothing, so it neither counts toward a non-empty
 * patch nor reaches the write. `null` is a value, and is kept.
 */
export function pickDefined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}
