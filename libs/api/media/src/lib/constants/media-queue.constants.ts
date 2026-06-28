/** BullMQ queue name; braces are the Dragonfly thread-affinity hash tag (see docs/REDIS.md). */
export enum MediaQueueNames {
  ContributionSweep = '{bge.media.contribution-sweep}',
}

export enum MediaJobNames {
  PurgeContribution = 'media.contribution.purge',
}
