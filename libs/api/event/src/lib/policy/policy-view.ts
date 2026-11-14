import type { EventPolicy, PlatformType, Prisma } from '@bge/database';

/**
 * What an event's policy is served as (#796, #1268): the row, and its allowed
 * platform types, platforms and categories as plain lists, so a client reads
 * `allowedPlatformIds` rather than join rows. An empty list means no
 * restriction of that kind.
 */
export type EventPolicyView = EventPolicy & {
  allowedPlatformTypes: PlatformType[];
  allowedPlatformIds: string[];
  allowedCategoryIds: string[];
};

/** The embed a policy read takes to be served as an `EventPolicyView`. */
export const EVENT_POLICY_VIEW_INCLUDE = {
  allowedPlatformTypes: { select: { platformType: true } },
  allowedPlatforms: { select: { platformId: true } },
  allowedCategories: { select: { categoryId: true } },
} as const satisfies Prisma.EventPolicyInclude;

export type EventPolicyRow = Prisma.EventPolicyGetPayload<{ include: typeof EVENT_POLICY_VIEW_INCLUDE }>;

/**
 * The row with its join rows flattened to lists. The lists are sorted, so the
 * same stored set reads the same whatever order its rows came back in, and two
 * reads compare by value.
 */
export function toEventPolicyView(row: EventPolicyRow): EventPolicyView {
  const { allowedPlatformTypes, allowedPlatforms, allowedCategories, ...policy } = row;

  return {
    ...policy,
    allowedPlatformTypes: allowedPlatformTypes.map(({ platformType }) => platformType).sort(),
    allowedPlatformIds: allowedPlatforms.map(({ platformId }) => platformId).sort(),
    allowedCategoryIds: allowedCategories.map(({ categoryId }) => categoryId).sort(),
  };
}
