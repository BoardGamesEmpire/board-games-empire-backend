import type { Prisma } from '@bge/database';

const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

/**
 * Deep JSON-safe conversion for audit persistence: Dates → ISO strings,
 * bigint → decimal string. Follows `JSON.stringify` semantics for `undefined`
 * — dropped as an object property, but coerced to `null` inside an array.
 * Snapshot payloads are plain Prisma row subsets, so cycles are a construction
 * error — a cyclic value throws and the listener's catch logs it as a failed
 * audit write.
 */
export function toJsonValue(value: object): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}

/**
 * Applies an `@AuditExclude` denylist to a before/after snapshot. Returns a
 * shallow copy without the denied keys; `null` passes through (create/delete
 * shapes). Redaction happens before serialization so denied values never
 * reach the row.
 */
export function redactSnapshot(
  snapshot: Readonly<Record<string, unknown>> | null,
  denylist: readonly string[],
): Record<string, unknown> | null {
  if (snapshot === null) {
    return null;
  }

  if (denylist.length === 0) {
    return { ...snapshot };
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!denylist.includes(key)) {
      redacted[key] = value;
    }
  }

  return redacted;
}
