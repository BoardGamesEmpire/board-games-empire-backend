/**
 * The status every event response carries. It is worked out on read by
 * `@bge/event` from the host's decisions (`archivedAt`, `cancelledAt`) and the
 * event's confirmed dates, and never stored (#795). The values are the ones
 * the stored column had, so the wire is unchanged.
 */
export const EventStatus = {
  Planning: 'Planning',
  Scheduled: 'Scheduled',
  Ongoing: 'Ongoing',
  Completed: 'Completed',
  Cancelled: 'Cancelled',
  Archived: 'Archived',
} as const;

export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];
