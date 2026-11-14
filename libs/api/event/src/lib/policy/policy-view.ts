import type { EventOccurrencePolicy, EventPolicy, PlatformType, Prisma } from '@bge/database';

/** A policy's allowed platform types, platforms and categories as plain lists (#1268). */
interface PolicyListsView {
  allowedPlatformTypes: PlatformType[];
  allowedPlatformIds: string[];
  allowedCategoryIds: string[];
}

/** The same lists as a read with a view's embed returns them: join rows. */
interface PolicyListJoinRows {
  allowedPlatformTypes: { platformType: PlatformType }[];
  allowedPlatforms: { platformId: string }[];
  allowedCategories: { categoryId: string }[];
}

/**
 * What an event's policy is served as (#796, #1268): the row, and its allowed
 * platform types, platforms and categories as plain lists, so a client reads
 * `allowedPlatformIds` rather than join rows. An empty list means no
 * restriction of that kind.
 */
export type EventPolicyView = EventPolicy & PolicyListsView;

/** The embed a policy read takes to be served as an `EventPolicyView`. */
export const EVENT_POLICY_VIEW_INCLUDE = {
  allowedPlatformTypes: { select: { platformType: true } },
  allowedPlatforms: { select: { platformId: true } },
  allowedCategories: { select: { categoryId: true } },
} as const satisfies Prisma.EventPolicyInclude;

export type EventPolicyRow = Prisma.EventPolicyGetPayload<{ include: typeof EVENT_POLICY_VIEW_INCLUDE }>;

/**
 * What a date's own policy is served as (#796, #1211): the row, with its lists
 * as an `EventPolicyView` has them. Each field holds only what the date sets
 * itself: an empty list or `null` means the event's, and a `*Unrestricted`
 * flag means no restriction of its kind for that date.
 */
export type OccurrencePolicyView = EventOccurrencePolicy & PolicyListsView;

/** The embed a date's policy read takes to be served as an `OccurrencePolicyView`. */
export const OCCURRENCE_POLICY_VIEW_INCLUDE = {
  allowedPlatformTypes: { select: { platformType: true } },
  allowedPlatforms: { select: { platformId: true } },
  allowedCategories: { select: { categoryId: true } },
} as const satisfies Prisma.EventOccurrencePolicyInclude;

export type OccurrencePolicyRow = Prisma.EventOccurrencePolicyGetPayload<{
  include: typeof OCCURRENCE_POLICY_VIEW_INCLUDE;
}>;

/**
 * A row with its join rows flattened to lists. The lists are sorted, so the
 * same stored set reads the same whatever order its rows came back in, and two
 * reads compare by value.
 */
function flattenPolicyLists<Row extends PolicyListJoinRows>(
  row: Row,
): Omit<Row, keyof PolicyListJoinRows> & PolicyListsView {
  const { allowedPlatformTypes, allowedPlatforms, allowedCategories, ...policy } = row;

  return {
    ...policy,
    allowedPlatformTypes: allowedPlatformTypes.map(({ platformType }) => platformType).sort(),
    allowedPlatformIds: allowedPlatforms.map(({ platformId }) => platformId).sort(),
    allowedCategoryIds: allowedCategories.map(({ categoryId }) => categoryId).sort(),
  };
}

export function toEventPolicyView(row: EventPolicyRow): EventPolicyView {
  return flattenPolicyLists(row);
}

export function toOccurrencePolicyView(row: OccurrencePolicyRow): OccurrencePolicyView {
  return flattenPolicyLists(row);
}
