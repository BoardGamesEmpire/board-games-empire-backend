import type { VerificationStore } from './app-sign-in-store';

export interface StoredRecord {
  readonly expiresAt: Date;
  readonly value: string;
}

/**
 * better-auth's verification store as the app sign-in records use it, in
 * memory: a record is taken out once, and one past its expiry reads as gone,
 * as `consumeVerificationValue` answers. `records` is there for a spec to read
 * or spoil what was stored.
 */
export function memoryVerificationStore(now: () => number = Date.now): {
  readonly records: Map<string, StoredRecord>;
  readonly store: VerificationStore;
} {
  const records = new Map<string, StoredRecord>();

  const store: VerificationStore = {
    async createVerificationValue({ identifier, value, expiresAt }) {
      records.set(identifier, { value, expiresAt });
      return {};
    },
    async consumeVerificationValue(identifier) {
      const record = records.get(identifier);
      records.delete(identifier);

      return record === undefined || record.expiresAt.getTime() < now() ? null : record;
    },
  };

  return { store, records };
}
