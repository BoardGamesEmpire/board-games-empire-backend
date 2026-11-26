import { DatePrecision, GameCondition, GameRemovalReason, Prisma } from '@bge/database';
import { z } from 'zod';
import type { Money } from './values/money';
import { moneyFromColumns } from './values/money';
import type { PartialDate } from './values/partial-date';
import { formatPartialDate, parsePartialDate } from './values/partial-date';

/**
 * The columns of a copy a revision keeps (#1231): every one a user edits,
 * its removal included, and the copy's id, which becomes the revision's
 * `copyId`. When the user last edited it, whether it is taken back, and the
 * upstream account that synced it are not the copy's description, so a
 * revision neither keeps nor restores them.
 */
export const COPY_REVISION_SELECT = {
  id: true,
  releaseId: true,
  condition: true,
  acquiredOn: true,
  acquiredOnPrecision: true,
  acquiredFrom: true,
  pricePaidAmount: true,
  pricePaidCurrency: true,
  currentValueAmount: true,
  currentValueCurrency: true,
  note: true,
  removedAt: true,
  removedOn: true,
  removedOnPrecision: true,
  removeReason: true,
} as const satisfies Prisma.CollectionCopySelect;

/** A copy as a revision is written from: {@link COPY_REVISION_SELECT}'s columns (#1231). */
export type CopyRevisionSource = Prisma.CollectionCopyGetPayload<{ select: typeof COPY_REVISION_SELECT }>;

/** The largest amount the money columns hold: a Postgres `integer` (#1231). */
const MAX_AMOUNT = 2_147_483_647;

const amount = z.number().int().min(0).max(MAX_AMOUNT).nullable();
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .nullable();
const precision = z.enum(DatePrecision).nullable();

/** Whether two columns the copy's CHECK constraints pair are both set or both unknown (#1231). */
function paired(first: unknown, second: unknown): boolean {
  return (first === null) === (second === null);
}

/**
 * A copy's values as a revision keeps them, in its `values` JSON (#1231).
 * Read back, they are data from outside the process, so they pass through
 * this schema before a restore writes them: it refuses what the copy's CHECK
 * constraints would, so a restore never fails on one.
 *
 * A column added to the copy later takes `.default(null)` here, so revisions
 * kept before it still parse.
 */
export const copyRevisionValuesSchema = z
  .object({
    /** Where the copy came from, in the user's words. */
    acquiredFrom: z.string().nullable(),

    /** The first day of the acquisition's period, as an ISO day (`2019-03-01`); null when unknown. */
    acquiredOn: z.iso.date().nullable(),

    acquiredOnPrecision: precision,

    condition: z.enum(GameCondition).nullable(),

    /** What the copy was worth, in the currency's minor units. */
    currentValueAmount: amount,

    currentValueCurrency: currency,

    note: z.string().nullable(),

    /** What was paid for the copy, in the currency's minor units. */
    pricePaidAmount: amount,

    pricePaidCurrency: currency,

    /** The copy's edition. The release may have been deleted since. */
    releaseId: z.string().min(1).nullable(),

    removeReason: z.enum(GameRemovalReason).nullable(),

    /** When the removal was recorded, as an ISO timestamp; null while the copy was owned. */
    removedAt: z.iso.datetime().nullable(),

    /** The first day of the removal's period, as an ISO day; null when unknown or not removed. */
    removedOn: z.iso.date().nullable(),

    removedOnPrecision: precision,
  })
  .refine((values) => paired(values.acquiredOn, values.acquiredOnPrecision), {
    path: ['acquiredOnPrecision'],
    error: 'acquiredOn and acquiredOnPrecision are set together',
  })
  .refine((values) => paired(values.removedOn, values.removedOnPrecision), {
    path: ['removedOnPrecision'],
    error: 'removedOn and removedOnPrecision are set together',
  })
  .refine((values) => paired(values.pricePaidAmount, values.pricePaidCurrency), {
    path: ['pricePaidCurrency'],
    error: 'pricePaidAmount and pricePaidCurrency are set together',
  })
  .refine((values) => paired(values.currentValueAmount, values.currentValueCurrency), {
    path: ['currentValueCurrency'],
    error: 'currentValueAmount and currentValueCurrency are set together',
  })
  .refine((values) => values.removedAt !== null || (values.removedOn === null && values.removeReason === null), {
    path: ['removedAt'],
    error: 'a removal date or reason needs removedAt',
  });

/** A copy's values as a revision keeps them (#1231). */
export type CopyRevisionValues = z.infer<typeof copyRevisionValuesSchema>;

/** The ISO day a `DATE` column holds, which Prisma reads as UTC midnight (#1231). */
function isoDay(date: Date | null): string | null {
  return date === null ? null : date.toISOString().slice(0, 10);
}

/** A copy's values, as {@link recordCopyRevisions} keeps them (#1231). */
export function copyRevisionValues(copy: CopyRevisionSource): CopyRevisionValues {
  return {
    releaseId: copy.releaseId,
    condition: copy.condition,
    acquiredOn: isoDay(copy.acquiredOn),
    acquiredOnPrecision: copy.acquiredOnPrecision,
    acquiredFrom: copy.acquiredFrom,
    pricePaidAmount: copy.pricePaidAmount,
    pricePaidCurrency: copy.pricePaidCurrency,
    currentValueAmount: copy.currentValueAmount,
    currentValueCurrency: copy.currentValueCurrency,
    note: copy.note,
    removedAt: copy.removedAt === null ? null : copy.removedAt.toISOString(),
    removedOn: isoDay(copy.removedOn),
    removedOnPrecision: copy.removedOnPrecision,
    removeReason: copy.removeReason,
  };
}

/**
 * Keeps what each copy says now as a revision of it, in one statement
 * (#1231). Every user write of a copy (an edit, a removal, a restore) calls
 * it under the entry's lock, with the copy as read in the same transaction,
 * before the copy is written.
 */
export async function recordCopyRevisions(
  tx: Prisma.TransactionClient,
  copies: readonly CopyRevisionSource[],
): Promise<void> {
  if (copies.length === 0) {
    return;
  }

  await tx.collectionCopyRevision.createMany({
    data: copies.map((copy) => ({ copyId: copy.id, values: copyRevisionValues(copy) })),
  });
}

/** {@link recordCopyRevisions} for one copy (#1231). */
export async function recordCopyRevision(tx: Prisma.TransactionClient, copy: CopyRevisionSource): Promise<void> {
  await recordCopyRevisions(tx, [copy]);
}

/** Why stored values failed {@link copyRevisionValuesSchema}, on one line, for the server's log (#1231). */
export function describeRevisionProblem(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? '(values)' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** What a copy's description says, as a user would send it adding the copy, but its release (#1231). */
export interface RestoredDescription {
  acquiredFrom: string | null;
  acquiredOn: string | null;
  condition: GameCondition | null;
  currentValue: Money | null;
  note: string | null;
  pricePaid: Money | null;
}

/** A copy's removal as a revision recorded it (#1231). */
export interface RestoredRemoval {
  removedAt: Date | null;
  removedOn: PartialDate | null;
  removeReason: GameRemovalReason | null;
}

/** A stored date read at its precision: the first day of its period (#1231). */
function storedDate(on: string | null, datePrecision: DatePrecision | null): PartialDate | null {
  if (on === null || datePrecision === null) {
    return null;
  }

  return parsePartialDate(formatPartialDate({ on: new Date(`${on}T00:00:00Z`), precision: datePrecision }));
}

/**
 * Parsed revision values, as a restore writes them back and the revisions
 * list shows them (#1231): the description in the shape a user sends it,
 * dates at their precision and prices as one value, so a restore is checked
 * as an edit is; and the removal as the revision kept it. The release is left to
 * the caller, which must find it still there.
 */
export function restoredCopyOf(values: CopyRevisionValues): {
  description: RestoredDescription;
  removal: RestoredRemoval;
} {
  const acquired = storedDate(values.acquiredOn, values.acquiredOnPrecision);

  return {
    description: {
      acquiredFrom: values.acquiredFrom,
      acquiredOn: acquired === null ? null : formatPartialDate(acquired),
      condition: values.condition,
      currentValue: moneyFromColumns(values.currentValueAmount, values.currentValueCurrency),
      note: values.note,
      pricePaid: moneyFromColumns(values.pricePaidAmount, values.pricePaidCurrency),
    },
    removal: {
      removedAt: values.removedAt === null ? null : new Date(values.removedAt),
      removedOn: storedDate(values.removedOn, values.removedOnPrecision),
      removeReason: values.removeReason,
    },
  };
}

/**
 * The release a restore may give the copy back (#1231): `releaseId` while it
 * is still a release of the entry's platform game, else null. A release
 * deleted since the revision was kept restores as no release, rather than
 * failing the write on its foreign key. The row is read `FOR SHARE`, under
 * the entry's lock, so it can't be deleted before the restore commits.
 */
export async function restorableRelease(
  tx: Prisma.TransactionClient,
  releaseId: string,
  platformGameId: string,
): Promise<string | null> {
  const [held] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM game_releases WHERE id = ${releaseId} AND platform_game_id = ${platformGameId} FOR SHARE
  `);

  return held?.id ?? null;
}
