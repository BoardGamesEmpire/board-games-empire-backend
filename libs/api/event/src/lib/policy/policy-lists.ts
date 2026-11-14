import type { PlatformType, Prisma } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

/** The allowed lists on an event's policy (#1268). A list left out is left as it is. */
export interface EventPolicyLists {
  allowedPlatformTypes?: PlatformType[];
  allowedPlatformIds?: string[];
  allowedCategoryIds?: string[];
}

/**
 * Refuses an id that names no platform or category, with a code a client can
 * announce. Without it an unknown id surfaces as a foreign key failure from the
 * write, which answers 500 (#1268). It runs in the write's transaction, so what
 * it found is what the write lands against.
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
  lists: EventPolicyLists,
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
  lists: EventPolicyLists,
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
