/**
 * The keys of a patch that name a value. A key present but `undefined` means
 * "not provided": it changes nothing, so it neither counts toward a non-empty
 * patch nor reaches the write. `null` is a value, and is kept.
 */
export function pickDefined<T extends object>(patch: T): Partial<T> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Object.fromEntries returns a string-keyed record, which TypeScript can't relate to `Partial<T>` for a generic `T` (#1321)
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}
