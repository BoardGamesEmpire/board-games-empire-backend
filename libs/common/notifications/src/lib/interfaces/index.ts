import { NotificationType } from '@bge/database';
import type { JobType, ResourceType } from '@bge/database';

/**
 * Per-`NotificationType` payload shapes.
 *
 * These replace the former single `NotificationPayload` grab-bag — an interface
 * of ~two-dozen optional fields where any payload structurally typechecked as
 * any other. Each notification type now carries exactly its own fields, so a
 * create site can no longer put an `EventRsvp` field on an `ImportFailed`
 * payload (or vice versa): the wrong field is a compile error.
 *
 * A type emitted from more than one site (or a family of related types) shares
 * one shape below. Shapes are named by intent, not by type, so families stay
 * DRY.
 */

/** A base/expansion game reached the system for the first time via import. */
export interface GameImportedPayload {
  gameId: string;
  gameTitle: string;
  thumbnail: string | null;
  jobId: string;
  batchId: string;
}

/** A watched base game gained an expansion — carries both game + base game. */
export interface WatchedExpansionImportedPayload {
  gameId: string;
  gameTitle: string;
  thumbnail: string | null;
  baseGameId: string;
  baseGameTitle: string;
}

/**
 * An import job failed terminally. `jobType` is the generic discriminator
 * clients key off (game import today, profile sync etc. later); the rest is
 * jobType-specific failure detail. `error` is the sanitized, user-safe message
 * and `errorCode` its stable classification (typed `string` to avoid coupling
 * this common lib to game-import's `ImportErrorCode`); the raw failure text
 * stays in `Job.error` / operator logs and never reaches the user.
 */
export interface ImportFailedPayload {
  jobType: JobType;
  jobId: string;
  batchId: string;
  gatewayId: string;
  externalId: string;
  isExpansion: boolean;
  errorCode: string;
  error: string;
}

/** A media contribution was rejected; the contributor may reclaim it until the deadline. */
export interface MediaContributionRejectedPayload {
  contributionId: string;
  mediaObjectId: string;
  subjectType: ResourceType;
  subjectId: string;
  rejectionReason: string | null;
  reclaimDeadline: string | null;
}

/** A rejected contribution's reclaim window lapsed and the object was purged. */
export interface MediaContributionReclaimExpiredPayload {
  contributionId: string;
  mediaObjectId: string;
  subjectType: ResourceType;
  subjectId: string;
}

/**
 * Admin-facing: an auditable event was persisted with no populated CLS actor
 * scope. `eventName` identifies (and dedupes) the offending code path;
 * `source` is typed `string` here to avoid coupling to actor-context's
 * `EventSource` union.
 */
export interface AuditUnattributedEventPayload {
  eventName: string;
  subject: string;
  source: string | null;
}

/** The minimal event reference every event-domain notification carries. */
export interface EventRefPayload {
  eventId: string;
  eventTitle: string;
}

/** Someone RSVP'd to an event the recipient hosts. */
export interface EventRsvpReceivedPayload extends EventRefPayload {
  attendeeName: string;
}

/** A game was nominated for an event (sent to fellow attendees). */
export interface GameNominatedPayload extends EventRefPayload {
  nominationId: string;
  nominatedGameTitle: string;
}

/** A nomination the recipient created was resolved (approved/rejected/passed/failed). */
export interface NominationOutcomePayload {
  eventId: string;
  nominationId: string;
  nominatedGameTitle: string;
}

/** A game was added to an event's play list. */
export interface GameAddedToEventPayload extends EventRefPayload {
  nominatedGameTitle: string;
}

/** An event occurrence changed status (confirmed/declined/canceled/…). */
export interface OccurrenceChangePayload extends EventRefPayload {
  occurrenceId: string;
  occurrenceLabel: string | null;
}

/** A user was invited to a household. Not yet emitted — shape is provisional. */
export interface HouseholdInviteReceivedPayload {
  householdId: string;
  householdName?: string;
}

/**
 * The single source of truth mapping every `NotificationType` to its payload
 * shape. Keyed by the enum value, so `NotificationPayloadMap[T]` resolves a
 * type's payload and the discriminated `UnreadNotificationDto` / typed
 * `create()` derive from here. Adding a `NotificationType` without a payload
 * here is caught by {@link _assertPayloadMapExhaustive} below.
 */
export type NotificationPayloadMap = {
  [NotificationType.GameImported]: GameImportedPayload;
  [NotificationType.ExpansionImported]: GameImportedPayload;
  [NotificationType.WatchedExpansionImported]: WatchedExpansionImportedPayload;
  [NotificationType.ImportFailed]: ImportFailedPayload;
  [NotificationType.MediaContributionRejected]: MediaContributionRejectedPayload;
  [NotificationType.MediaContributionReclaimExpired]: MediaContributionReclaimExpiredPayload;
  [NotificationType.AuditUnattributedEvent]: AuditUnattributedEventPayload;
  [NotificationType.HouseholdInviteReceived]: HouseholdInviteReceivedPayload;
  [NotificationType.EventInviteReceived]: EventRefPayload;
  [NotificationType.EventCreated]: EventRefPayload;
  [NotificationType.EventRsvpReceived]: EventRsvpReceivedPayload;
  [NotificationType.GameNominated]: GameNominatedPayload;
  [NotificationType.GameNominationApproved]: NominationOutcomePayload;
  [NotificationType.GameNominationRejected]: NominationOutcomePayload;
  [NotificationType.GameNominationPassed]: NominationOutcomePayload;
  [NotificationType.GameNominationFailed]: NominationOutcomePayload;
  [NotificationType.GameAddedToEvent]: GameAddedToEventPayload;
  // Occurrence lifecycle — Confirmed/Canceled/Declined are emitted today;
  // Proposed/Rescheduled are not yet, but share the same shape.
  [NotificationType.EventOccurrenceProposed]: OccurrenceChangePayload;
  [NotificationType.EventOccurrenceConfirmed]: OccurrenceChangePayload;
  [NotificationType.EventOccurrenceCanceled]: OccurrenceChangePayload;
  [NotificationType.EventOccurrenceDeclined]: OccurrenceChangePayload;
  [NotificationType.EventOccurrenceRescheduled]: OccurrenceChangePayload;
};

/**
 * Compile-time exhaustiveness guard: if a `NotificationType` is added without a
 * `NotificationPayloadMap` entry, `_MissingNotificationPayload` stops being
 * `never` and this assignment fails, naming the unmapped key(s). Zero runtime
 * cost.
 */
type _MissingNotificationPayload = Exclude<NotificationType, keyof NotificationPayloadMap>;
const _assertPayloadMapExhaustive: [_MissingNotificationPayload] extends [never]
  ? true
  : { readonly __unmappedNotificationTypes: _MissingNotificationPayload } = true;
void _assertPayloadMapExhaustive;

/** Union of every notification payload shape (the old `NotificationPayload`). */
export type NotificationPayload = NotificationPayloadMap[NotificationType];

/**
 * Input to `NotificationsService.create`. Parameterized over the notification
 * type so a create site with a literal `type` is checked against exactly that
 * type's payload. Defaulted to the full union so an aggregate list
 * (`CreateNotificationInput[]`) still types the heterogeneous case.
 */
export interface CreateNotificationInput<T extends NotificationType = NotificationType> {
  payload: NotificationPayloadMap[T];
  type: T;
  userId: string;
}

/**
 * One unread notification as returned to clients — a discriminated union on
 * `type`, so a consumer that narrows `type` gets the exact `payload` shape.
 */
export type UnreadNotificationDto = {
  [T in NotificationType]: {
    createdAt: Date;
    id: string;
    payload: NotificationPayloadMap[T];
    read: boolean;
    type: T;
  };
}[NotificationType];
