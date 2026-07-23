import { PluginCategory } from '@bge/database';
import type { PluginCategoryValue } from '@boardgamesempire/plugin-manifest';

/**
 * Manifest category (kebab-case, the `@boardgamesempire/plugin-manifest`
 * source of truth) → generated Prisma `PluginCategory` enum (PascalCase).
 * This map is the ONE place the two vocabularies are bridged; the bijection
 * spec asserts it is total and injective in both directions, so a category
 * added to one side without the other fails CI rather than drifting
 * silently — this is the enforcement behind the claim in the
 * `plugin-category.prisma` doc comment.
 */
export const MANIFEST_CATEGORY_TO_PRISMA: Readonly<Record<PluginCategoryValue, PluginCategory>> = {
  'data-gateway': PluginCategory.DataGateway,
  'notification-channel': PluginCategory.NotificationChannel,
  'storage-driver': PluginCategory.StorageDriver,
  'media-integration': PluginCategory.MediaIntegration,
  'feedback-sink': PluginCategory.FeedbackSink,
  'analytics-sink': PluginCategory.AnalyticsSink,
  observability: PluginCategory.Observability,
  'backup-sink': PluginCategory.BackupSink,
  'calendar-sync': PluginCategory.CalendarSync,
  'recommendation-engine': PluginCategory.RecommendationEngine,
  'event-hook': PluginCategory.EventHook,
};

/** Reverse lookup for surfacing a stored category back to its manifest form. */
export const PRISMA_CATEGORY_TO_MANIFEST = Object.fromEntries(
  Object.entries(MANIFEST_CATEGORY_TO_PRISMA).map(([manifestValue, prismaValue]) => [prismaValue, manifestValue]),
) as Readonly<Record<PluginCategory, PluginCategoryValue>>;
