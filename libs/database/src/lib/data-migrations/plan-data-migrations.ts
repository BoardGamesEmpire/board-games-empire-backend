import type { DataMigrationEntry, DataMigrationLedgerRow } from './data-migration-entry';

/** An applied entry the ledger and the build hold at different revisions; which side is higher says what happened. */
export interface RevisionMismatch {
  readonly name: string;
  readonly codeRevision: number;
  readonly ledgerRevision: number;
}

/** One mismatch, worded the same in the refusal, the warning and `db:plan`. */
export function describeMismatch({ name, codeRevision, ledgerRevision }: RevisionMismatch): string {
  return `'${name}' is at revision ${codeRevision} in this build and revision ${ledgerRevision} in the ledger`;
}

export interface DataMigrationsPlan {
  /** Registry entries without a ledger row, in apply (name) order. */
  readonly pending: readonly DataMigrationEntry[];
  /** Registry entries the ledger records at the same revision. */
  readonly applied: readonly string[];
  /**
   * Registry entries at a revision above the ledger's in this build. The
   * ledger's revision is the one that ran, so the entry was edited after it
   * ran, without a new entry; any one of them refuses boot.
   */
  readonly edited: readonly RevisionMismatch[];
  /**
   * Registry entries the ledger records at a revision above this build's: a
   * newer build ran them, and this build is a rollback across that edit. Left
   * alone, as unknown rows and an ahead schema are; the newer build owns the
   * data.
   */
  readonly ahead: readonly RevisionMismatch[];
  /** Ledger rows the registry does not know: a newer build applied them, or an entry was removed. */
  readonly unknown: readonly string[];
}

/** A Prisma migration directory's shape: a 14-digit timestamp, then a snake-case name. */
const ENTRY_NAME = /^\d{14}_[a-z][a-z0-9_]*$/;

/** The ledger's `revision` column is a Postgres `integer`; a revision above this passes every check until its first insert. */
const MAX_REVISION = 2_147_483_647;

/** Names are ASCII by {@link ENTRY_NAME}, so code-point order is the order. */
const byName = (a: DataMigrationEntry, b: DataMigrationEntry): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Compares the registry this build ships with the rows in `data_migrations`.
 * Pure, so every row of the decision is a unit test; the read and the writes
 * are `applyDataMigrations`. The registry is checked on the way in: a
 * duplicate name would let one row satisfy two entries, a name outside the
 * timestamp shape would sort somewhere its author did not intend, and a
 * revision the ledger column cannot hold would fail at its first insert.
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
  const edited: RevisionMismatch[] = [];
  const ahead: RevisionMismatch[] = [];

  for (const entry of ordered) {
    const ledgerRevision = ledger.get(entry.name);
    if (ledgerRevision === undefined) {
      pending.push(entry);
    } else if (ledgerRevision === entry.revision) {
      applied.push(entry.name);
    } else if (entry.revision > ledgerRevision) {
      edited.push({ name: entry.name, codeRevision: entry.revision, ledgerRevision });
    } else {
      ahead.push({ name: entry.name, codeRevision: entry.revision, ledgerRevision });
    }
  }

  const unknown = rows
    .map((row) => row.name)
    .filter((name) => !known.has(name))
    .sort();

  return { pending, applied, edited, ahead, unknown };
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

    if (!Number.isInteger(entry.revision) || entry.revision < 1 || entry.revision > MAX_REVISION) {
      throw new Error(
        `Data migration '${entry.name}' has revision ${String(entry.revision)}; a revision is an integer from 1 to ${MAX_REVISION}, what the ledger's integer column holds.`,
      );
    }
  }
}
