import { isDeepStrictEqual } from 'node:util';

/**
 * The keys whose values differ between two rows of one record, compared by
 * value so two equal `Date`s are unchanged. An update-shaped MutationEvent
 * records these and nothing else (#728); an empty result means the update
 * changed nothing and emits no event.
 */
export function changedKeys<T extends object>(before: T, after: T, keys: readonly (keyof T)[]): (keyof T)[] {
  return keys.filter((key) => !isDeepStrictEqual(before[key], after[key]));
}

/**
 * Changed-subset snapshot for update-shaped MutationEvents: the changed keys
 * (from `changedKeys`) plus `id`. Shared by every service in this lib that
 * emits update events.
 */
export function pickSnapshot<T extends { id: string }>(row: T, keys: readonly (keyof T)[]): Partial<T> & Pick<T, 'id'> {
  const snapshot: Record<string, unknown> = { id: row.id };
  for (const key of keys) {
    snapshot[key as string] = row[key];
  }
  return snapshot as Partial<T> & Pick<T, 'id'>;
}
