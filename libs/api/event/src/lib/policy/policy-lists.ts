import type { Prisma } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';
import { changedKeys, pickSnapshot } from '../utils/pick-snapshot.util';
import type { PolicyListsView } from './policy-view';

/**
 * The allowed lists sent with a policy write, the event's or a date's (#1268).
 * A list left out is left as it is.
 */
export type PolicyLists = Partial<PolicyListsView>;

/** The lists a policy write changes, as they were and as they will be stored. */
export interface ChangedPolicyLists {
  before: PolicyLists;
  after: PolicyLists;
}

const LIST_KEYS = ['allowedPlatformTypes', 'allowedPlatformIds', 'allowedCategoryIds'] as const;

/** Whether two lists hold the same members, whatever their order. */
function sameMembers(stored: readonly string[], sent: readonly string[]): boolean {
  const members = new Set(stored);
  const sentMembers = new Set(sent);

  return members.size === sentMembers.size && [...sentMembers].every((member) => members.has(member));
}

/**
 * The lists sent whose members differ from the stored ones, as they were
 * (`before`) and as they will be stored (`after`) (#1268). A list equal to the
 * stored one in any order, or left out, is no change. Both sides are
 * deduplicated and sorted, as the lists are stored and served, so an audit
 * entry's before and after compare by value. `after` is what the write
 * replaces, and its keys, in the lists' own order, name what changed.
 */
export function changedPolicyLists(stored: PolicyListsView, sent: PolicyLists): ChangedPolicyLists {
  const changed = LIST_KEYS.filter((key) => {
    const list = sent[key];
    return list !== undefined && !sameMembers(stored[key], list);
  });

  return {
    before: Object.fromEntries(changed.map((key) => [key, stored[key]])),
    after: Object.fromEntries(changed.map((key) => [key, [...new Set(sent[key])].sort()])),
  };
}

/**
 * A policy patch, the event's or a date's, split into the columns it sets and
 * the lists it changes, measured against the stored policy with
 * {@link changedPolicyLists} (#1268). The lists are not columns of the row:
 * the columns go to the row's write, and the changed lists to
 * `replaceEventPolicyLists` or `replaceOccurrencePolicyLists`.
 */
export function splitPolicyPatch<Patch extends PolicyLists>(stored: PolicyListsView, patch: Patch) {
  const { allowedPlatformTypes, allowedPlatformIds, allowedCategoryIds, ...columns } = patch;

  return {
    columns,
    lists: changedPolicyLists(stored, { allowedPlatformTypes, allowedPlatformIds, allowedCategoryIds }),
  };
}

/**
 * The columns a policy write sets on its row. Prisma moves `updatedAt` only
 * when it writes a column, and the lists are not columns, so a write that
 * changes a list moves it here (#1268).
 */
export function policyColumnsUpdate<Columns extends object>(
  columns: Columns,
  lists: ChangedPolicyLists,
): Columns & { updatedAt?: Date } {
  return Object.keys(lists.after).length > 0 ? { ...columns, updatedAt: new Date() } : columns;
}

/**
 * What a policy write changed, for its audit entry and webhook (#728, #1268):
 * the names of the columns whose values changed and of the lists that
 * changed, and their values before and after, with the row's `id`. The lists
 * are not columns of the row, so their values come from what was read before
 * the write and what it wrote. An empty `changed` means the write changed
 * nothing and emits nothing.
 */
export function policyChange<Columns extends object>(
  before: Columns & { id: string },
  after: Columns & { id: string },
  columnKeys: readonly (keyof Columns)[],
  lists: ChangedPolicyLists,
) {
  const changedColumns = changedKeys<Columns>(before, after, columnKeys);

  return {
    changed: [...changedColumns, ...Object.keys(lists.after)],
    before: { ...pickSnapshot(before, changedColumns), ...lists.before },
    after: { ...pickSnapshot(after, changedColumns), ...lists.after },
  };
}

/**
 * Refuses an id that names no platform or category, with a code a client can
 * announce. Without it an unknown id surfaces as a foreign key failure from the
 * write, which answers 500 (#1268). It runs in the write's transaction, but a
 * count locks nothing: a platform or category deleted between this check and
 * the write still fails the write that way.
 */
export async function assertPolicyReferencesExist(
  tx: Pick<Prisma.TransactionClient, 'platform' | 'category'>,
  references: { platformIds?: string[]; categoryIds?: string[] },
): Promise<void> {
  const platformIds = [...new Set(references.platformIds)];
  const categoryIds = [...new Set(references.categoryIds)];

  const platforms = platformIds.length > 0 ? await tx.platform.count({ where: { id: { in: platformIds } } }) : 0;
  if (platforms !== platformIds.length) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_POLICY_UNKNOWN_REFERENCE',
      t('errors.event_policy.unknown_platform'),
    );
  }

  const categories = categoryIds.length > 0 ? await tx.category.count({ where: { id: { in: categoryIds } } }) : 0;
  if (categories !== categoryIds.length) {
    throw new CodedHttpException(
      Http.BadRequest,
      'EVENT_POLICY_UNKNOWN_REFERENCE',
      t('errors.event_policy.unknown_category'),
    );
  }
}

/** The nested create of the lists given, for a policy being created with them. */
export function policyListsCreateData(
  lists: PolicyLists,
): Pick<Prisma.EventPolicyCreateWithoutEventInput, 'allowedPlatformTypes' | 'allowedPlatforms' | 'allowedCategories'> {
  return {
    ...(lists.allowedPlatformTypes?.length
      ? {
          allowedPlatformTypes: {
            create: [...new Set(lists.allowedPlatformTypes)].map((platformType) => ({ platformType })),
          },
        }
      : {}),
    ...(lists.allowedPlatformIds?.length
      ? {
          allowedPlatforms: {
            create: [...new Set(lists.allowedPlatformIds)].map((platformId) => ({
              platform: { connect: { id: platformId } },
            })),
          },
        }
      : {}),
    ...(lists.allowedCategoryIds?.length
      ? {
          allowedCategories: {
            create: [...new Set(lists.allowedCategoryIds)].map((categoryId) => ({
              category: { connect: { id: categoryId } },
            })),
          },
        }
      : {}),
  };
}

/**
 * Replaces each list sent with the one stored: its rows go, then the new ones
 * are made. `[]` clears a list, and a list left out stays (#1268). The caller
 * holds the event's lock, so no other write to the policy sees the gap between
 * the two statements.
 */
export async function replaceEventPolicyLists(
  tx: Pick<Prisma.TransactionClient, 'eventPolicyPlatformType' | 'eventPolicyPlatform' | 'eventPolicyCategory'>,
  eventPolicyId: string,
  lists: PolicyLists,
): Promise<void> {
  if (lists.allowedPlatformTypes) {
    await tx.eventPolicyPlatformType.deleteMany({ where: { eventPolicyId } });
    await tx.eventPolicyPlatformType.createMany({
      data: [...new Set(lists.allowedPlatformTypes)].map((platformType) => ({ eventPolicyId, platformType })),
    });
  }

  if (lists.allowedPlatformIds) {
    await tx.eventPolicyPlatform.deleteMany({ where: { eventPolicyId } });
    await tx.eventPolicyPlatform.createMany({
      data: [...new Set(lists.allowedPlatformIds)].map((platformId) => ({ eventPolicyId, platformId })),
    });
  }

  if (lists.allowedCategoryIds) {
    await tx.eventPolicyCategory.deleteMany({ where: { eventPolicyId } });
    await tx.eventPolicyCategory.createMany({
      data: [...new Set(lists.allowedCategoryIds)].map((categoryId) => ({ eventPolicyId, categoryId })),
    });
  }
}

/**
 * {@link replaceEventPolicyLists} for a date's own policy (#796). On a date,
 * `[]` hands the list back to the event's rather than lifting it.
 */
export async function replaceOccurrencePolicyLists(
  tx: Pick<
    Prisma.TransactionClient,
    'occurrencePolicyPlatformType' | 'occurrencePolicyPlatform' | 'occurrencePolicyCategory'
  >,
  occurrencePolicyId: string,
  lists: PolicyLists,
): Promise<void> {
  if (lists.allowedPlatformTypes) {
    await tx.occurrencePolicyPlatformType.deleteMany({ where: { occurrencePolicyId } });
    await tx.occurrencePolicyPlatformType.createMany({
      data: [...new Set(lists.allowedPlatformTypes)].map((platformType) => ({ occurrencePolicyId, platformType })),
    });
  }

  if (lists.allowedPlatformIds) {
    await tx.occurrencePolicyPlatform.deleteMany({ where: { occurrencePolicyId } });
    await tx.occurrencePolicyPlatform.createMany({
      data: [...new Set(lists.allowedPlatformIds)].map((platformId) => ({ occurrencePolicyId, platformId })),
    });
  }

  if (lists.allowedCategoryIds) {
    await tx.occurrencePolicyCategory.deleteMany({ where: { occurrencePolicyId } });
    await tx.occurrencePolicyCategory.createMany({
      data: [...new Set(lists.allowedCategoryIds)].map((categoryId) => ({ occurrencePolicyId, categoryId })),
    });
  }
}
