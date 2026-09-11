import type { DataMigrationEntry, DataMigrationLedgerRow } from './data-migration-entry';

/** An applied entry the ledger and the build hold at different revisions: edited after it ran, or a rollback across such an edit. */
export interface RevisionMismatch {
  readonly name: string;
  readonly codeRevision: number;
  readonly ledgerRevision: number;
}

/** One mismatch, worded the same in the refusal and in `db:plan`. */
export function describeMismatch({ name, codeRevision, ledgerRevision }: RevisionMismatch): string {
  return `'${name}' is at revision ${codeRevision} in this build and revision ${ledgerRevision} in the ledger`;
}

export interface DataMigrationsPlan {
  /** Registry entries without a ledger row, in apply (name) order. */
  readonly pending: readonly DataMigrationEntry[];
  /** Registry entries the ledger records at the same revision. */
  readonly applied: readonly string[];
  /** Registry entries the ledger records at another revision; any one of them refuses boot. */
  readonly mismatched: readonly RevisionMismatch[];
  /** Ledger rows the registry does not know: a newer build applied them, or an entry was removed. */
  readonly unknown: readonly string[];
}

/** A Prisma migration directory's shape: a 14-digit timestamp, then a snake-case name. */
const ENTRY_NAME = /^\d{14}_[a-z][a-z0-9_]*$/;

/** Names are ASCII by {@link ENTRY_NAME}, so code-point order is the order. */
const byName = (a: DataMigrationEntry, b: DataMigrationEntry): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Compares the registry this build ships with the rows in `data_migrations`.
 * Pure, so every row of the decision is a unit test; the read and the writes
 * are `applyDataMigrations`. The registry is checked on the way in: a
 * duplicate name would let one row satisfy two entries, and a name outside
 * the timestamp shape would sort somewhere its author did not intend.
 */
export function planDataMigrations(
  entries: readonly DataMigrationEntry[],
  rows: readonly DataMigrationLedgerRow[],
): DataMigrationsPlan {
  assertDataMigrationRegistry(entries);

  const ordered = [...entries].sort(byName);
  const ledger = new Map(rows.map((row) => [row.name, row.revision]));
  const known = new Set(entries.map((entry) => entry.name));

  const pending: DataMigrationEntry[] = [];
  const applied: string[] = [];
  const mismatched: RevisionMismatch[] = [];

  for (const entry of ordered) {
    const ledgerRevision = ledger.get(entry.name);
    if (ledgerRevision === undefined) {
      pending.push(entry);
    } else if (ledgerRevision === entry.revision) {
      applied.push(entry.name);
    } else {
      mismatched.push({ name: entry.name, codeRevision: entry.revision, ledgerRevision });
    }
  }

  const unknown = rows
    .map((row) => row.name)
    .filter((name) => !known.has(name))
    .sort();

  return { pending, applied, mismatched, unknown };
}

/**
 * The registry is code, so these are programming errors, thrown rather than
 * planned around: they fail the first boot or `db:plan` that loads the entry,
 * and the unit test over the shipped registry, before any database sees it.
 */
export function assertDataMigrationRegistry(entries: readonly DataMigrationEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`The data-migration registry names '${entry.name}' twice; every entry needs a name of its own.`);
    }
    seen.add(entry.name);

    if (!ENTRY_NAME.test(entry.name)) {
      throw new Error(
        `Data migration '${entry.name}' needs a name of the form YYYYMMDDHHMMSS_snake_case, like a Prisma migration's directory: its name is its place in the order.`,
      );
    }

    if (!Number.isInteger(entry.revision) || entry.revision < 1) {
      throw new Error(
        `Data migration '${entry.name}' has revision ${String(entry.revision)}; a revision is a positive integer, starting at 1.`,
      );
    }
  }
}
