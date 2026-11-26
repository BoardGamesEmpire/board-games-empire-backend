import { DatePrecision, GameCondition, GameRemovalReason, Prisma } from '@bge/database';
import type { Logger } from '@nestjs/common';
import { z } from 'zod';
import { revisionNotFound } from './game-collection.errors';
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

/** Why stored values failed their schema, on one line, for the server's log (#1231). */
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

/**
 * A revision's stored values, parsed through `schema` (#1231): they are data
 * from outside the process. Null when they fail it, which the server's log
 * says on one line, naming `subject`, since nestjs-pino drops an Error
 * argument.
 */
export function parseRevisionValues<S extends z.ZodType>(
  schema: S,
  stored: unknown,
  logger: Pick<Logger, 'error'>,
  subject: string,
): z.output<S> | null {
  const parsed = schema.safeParse(stored);

  if (!parsed.success) {
    logger.error(`${subject} can't be read back: ${describeRevisionProblem(parsed.error)}`);

    return null;
  }

  return parsed.data;
}

/**
 * The order a revisions list reads in: newest first, then by id, so revisions
 * kept in the same instant keep one order (#1231). A copy's revisions and a
 * rating change's both read in it.
 */
export const REVISION_ORDER: { createdAt?: Prisma.SortOrder; id?: Prisma.SortOrder }[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

/** What a revisions list reads of a copy's or a rating change's revisions, in {@link REVISION_ORDER} (#1231). */
export const REVISION_LIST_READ = {
  select: { createdAt: true, id: true, values: true },
  orderBy: REVISION_ORDER,
} as const;

/** A revision as a revisions list reads it (#1231). */
export interface StoredRevision {
  createdAt: Date;
  id: string;
  values: unknown;
}

/**
 * The revisions of a list whose stored values read back through `schema`,
 * each beside its values, in the order given (#1231). One that fails the
 * schema is left out, as it can't be restored either, and the server's log
 * says why, naming the revision as `subject` does.
 */
export function readableRevisions<S extends z.ZodType>(
  schema: S,
  revisions: readonly StoredRevision[],
  logger: Pick<Logger, 'error'>,
  subject: (revisionId: string) => string,
): { revision: StoredRevision; values: z.output<S> }[] {
  return revisions.flatMap((revision) => {
    const values = parseRevisionValues(schema, revision.values, logger, subject(revision.id));

    return values === null ? [] : [{ revision, values }];
  });
}

/**
 * The values of the revision `found` holds, the one a restore asked for by
 * `revisionId`, read back through `schema` (#1231). None found, a revision of
 * another copy or change, or values that fail the schema answer
 * `COLLECTION_REVISION_NOT_FOUND`, which the 404 never tells apart.
 */
export function restorableValues<S extends z.ZodType>(
  schema: S,
  found: { values: unknown } | null,
  revisionId: string,
  logger: Pick<Logger, 'error'>,
  subject: string,
): z.output<S> {
  const values = found === null ? null : parseRevisionValues(schema, found.values, logger, subject);

  if (values === null) {
    throw revisionNotFound(revisionId);
  }

  return values;
}

/**
 * Whether a take-back (`takenBack` true) or the undo of one (false) finds the
 * copy or rating change already as it asks (#1231). Such a repeat answers the
 * row as it stands and writes nothing to it, no stamp and no revision, and
 * nothing is emitted: ADR 0002's rule for a state change already in the state
 * asked for, so a client that sends it again can't tell a retry from the
 * first request.
 */
export function isAlreadyTakenBackAs(row: { retractedAt: Date | null }, takenBack: boolean): boolean {
  return (row.retractedAt !== null) === takenBack;
}

/**
 * What a take-back (`takenBack` true) or the undo of one writes to a copy or a
 * rating change (#1231): `retractedAt`, and the stamp that the user edited
 * it, so an upstream sync never undoes the user's word. It changes none of the
 * values a revision holds, so neither keeps a revision.
 */
export function takeBackData(takenBack: boolean, now: Date): { editedByUserAt: Date; retractedAt: Date | null } {
  return { editedByUserAt: now, retractedAt: takenBack ? now : null };
}

/**
 * The columns of a rating change a revision keeps (#1231): the rating and its
 * date, which a user edits, and the change's id, which becomes the revision's
 * `ratingChangeId`. When the user last edited it, whether it is taken back
 * and the upstream account that synced it are not the change's description,
 * so a revision neither keeps nor restores them.
 */
export const RATING_REVISION_SELECT = {
  id: true,
  occurredOn: true,
  occurredOnPrecision: true,
  rating: true,
} as const satisfies Prisma.CollectionRatingChangeSelect;

/** A rating change as a revision is written from: {@link RATING_REVISION_SELECT}'s columns (#1231). */
export type RatingRevisionSource = Prisma.CollectionRatingChangeGetPayload<{
  select: typeof RATING_REVISION_SELECT;
}>;

/**
 * A rating change's values as a revision keeps them, in its `values` JSON
 * (#1231). Read back, they pass through this schema before a restore writes
 * them: it refuses what the change's CHECK constraints would (a rating from 1
 * to 10, and a date set with its precision), so a restore never fails on one.
 */
export const ratingRevisionValuesSchema = z
  .object({
    /** The first day of the date's period, as an ISO day (`2019-03-01`); null when unknown. */
    occurredOn: z.iso.date().nullable(),

    occurredOnPrecision: precision,

    /** The rating from then on; null when the change cleared it. */
    rating: z.number().int().min(1).max(10).nullable(),
  })
  .refine((values) => paired(values.occurredOn, values.occurredOnPrecision), {
    path: ['occurredOnPrecision'],
    error: 'occurredOn and occurredOnPrecision are set together',
  });

/** A rating change's values as a revision keeps them (#1231). */
export type RatingRevisionValues = z.infer<typeof ratingRevisionValuesSchema>;

/** A rating change's values, as {@link recordRatingRevision} keeps them (#1231). */
export function ratingRevisionValues(change: RatingRevisionSource): RatingRevisionValues {
  return {
    occurredOn: isoDay(change.occurredOn),
    occurredOnPrecision: change.occurredOnPrecision,
    rating: change.rating,
  };
}

/**
 * Keeps what a rating change says now as a revision of it (#1231). Every
 * user edit or restore of a change calls it under the entry's lock, with the
 * change as read in the same transaction, before the change is written. A
 * take-back changes none of these values, so it keeps none.
 */
export async function recordRatingRevision(tx: Prisma.TransactionClient, change: RatingRevisionSource): Promise<void> {
  await tx.collectionRatingRevision.create({
    data: { ratingChangeId: change.id, values: ratingRevisionValues(change) },
    select: { id: true },
  });
}

/**
 * Parsed rating revision values, as a restore writes them back and the
 * revisions list shows them (#1231): the date at its precision, so a restore
 * is checked as an edit is.
 */
export function restoredRatingOf(values: RatingRevisionValues): {
  occurredOn: PartialDate | null;
  rating: number | null;
} {
  return { occurredOn: storedDate(values.occurredOn, values.occurredOnPrecision), rating: values.rating };
}
