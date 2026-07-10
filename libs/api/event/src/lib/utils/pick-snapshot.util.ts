/**
 * Changed-subset snapshot for update-shaped MutationEvents: the touched keys
 * plus `id`. Shared by every service in this lib that emits update events.
 */
export function pickSnapshot<T extends { id: string }>(
  row: T,
  keys: readonly (keyof T)[],
): Partial<T> & Pick<T, 'id'> {
  const snapshot: Record<string, unknown> = { id: row.id };
  for (const key of keys) {
    snapshot[key as string] = row[key];
  }
  return snapshot as Partial<T> & Pick<T, 'id'>;
}
