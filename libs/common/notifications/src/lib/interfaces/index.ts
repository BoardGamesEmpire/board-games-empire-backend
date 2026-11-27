import type {
  DataGatewayCapability,
  EventParticipationStatus,
  JobType,
  NotificationType,
  ResourceType,
} from '@bge/database';
import type { I18nMessage } from '@bge/i18n';
import type { MailFailureCode } from '@bge/mail';

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
  batchId: string;
  gameId: string;
  gameTitle: string;
  jobId: string;
  thumbnail: string | null;
}

/** A watched base game gained an expansion — carries both game + base game. */
export interface WatchedExpansionImportedPayload {
  baseGameId: string;
  baseGameTitle: string;
  gameId: string;
  gameTitle: string;
  thumbnail: string | null;
}

/**
 * An import job failed terminally. `jobType` is the generic discriminator
 * clients key off (game import today, profile sync etc. later); the rest is
 * jobType-specific failure detail. `errorCode` is the stable classification
 * (typed `string` to avoid coupling this common lib to game-import's
 * `ImportErrorCode`); the raw failure text stays in `Job.error` / operator logs
 * and never reaches the user.
 *
 * `error` is the sanitized, user-safe message, stored as a `t()` marker rather
 * than text (#188). `I18nResponseInterceptor` renders it on
 * `GET /notifications/unread` in the reader's locale, so on the wire it is a
 * string. Anything that reads the row in-process gets the marker and must render
 * it for its recipient.
 */
export interface ImportFailedPayload {
  batchId: string;
  error: I18nMessage;
  errorCode: string;
  externalId: string;
  gatewayId: string;
  jobId: string;
  jobType: JobType;

  /**
   * Why the job was in its import batch: `Requested`, `ChosenExpansion` or
   * `AddedBaseGame` (#971).
   */
  origin: string;
}

/** A media contribution was rejected; the contributor may reclaim it until the deadline. */
export interface MediaContributionRejectedPayload {
  contributionId: string;
  mediaObjectId: string;
  reclaimDeadline: string | null;
  rejectionReason: string | null;
  subjectId: string;
  subjectType: ResourceType;
}

/** A rejected contribution's reclaim window lapsed and the object was purged. */
export interface MediaContributionReclaimExpiredPayload {
  contributionId: string;
  mediaObjectId: string;
  subjectId: string;
  subjectType: ResourceType;
}

/**
 * Admin-facing: an auditable event was persisted with no populated CLS actor
 * scope. `eventName` identifies (and dedupes) the offending code path;
 * `source` is typed `string` here to avoid coupling to actor-context's
 * `EventSource` union.
 */
export interface AuditUnattributedEventPayload {
  eventName: string;
  source: string | null;
  subject: string;
}

/** The DataGateway a server-admin notification is about (#763). */
export interface DataGatewayRefPayload {
  gatewayId: string;
  gatewayName: string;
}

/**
 * For server admins: repeated failures auto-disabled a DataGateway (#763).
 * `reason` is `repeated_connection_failure` or `repeated_call_failure`, a
 * stable code the client words; it is typed `string` so this common lib
 * doesn't depend on the gateway registry. `lastError` is the upstream's own
 * text, untranslated, so they needn't read it in the logs; it's cut to its
 * first 1,000 characters, with U+FFFD in place of any character PostgreSQL
 * can't store in JSON. Times are ISO 8601.
 */
export interface DataGatewayAutoDisabledPayload extends DataGatewayRefPayload {
  consecutiveFailures: number;
  firstFailureAt: string;
  lastError: string;
  lastFailureAt: string;
  reason: string;
}

/**
 * For server admins: an interview found capabilities gone that the server
 * was routing (#763). Capabilities a server admin switched off are left out
 * (#715). The list keeps the enum's order, the order the DataGateway row
 * stores them in.
 */
export interface DataGatewayCapabilitiesLostPayload extends DataGatewayRefPayload {
  lostCapabilities: DataGatewayCapability[];
}

/** The minimal event reference every event-domain notification carries. */
export interface EventRefPayload {
  eventId: string;
  eventTitle: string;
}

/** A user was invited to an event; sent to the invitee once their inbox lists the invite (#742). */
export interface EventInviteReceivedPayload extends EventRefPayload {
  inviteId: string;
  inviterName: string;
}

/**
 * An invitee answered an event invite; sent to the inviter (#742). The name is
 * the invitee's as it is shown, never an address.
 */
export interface EventInviteAnsweredPayload extends EventRefPayload {
  inviteeName: string;
  inviteId: string;
}

/** An event the recipient attends was cancelled, with the host's reason if given (#795). */
export interface EventCancelledPayload extends EventRefPayload {
  reason: string | null;
}

/** Someone RSVP'd to an event the recipient hosts. */
export interface EventRsvpReceivedPayload extends EventRefPayload {
  /** `null` is an attendee without an account, and the client words it. */
  attendeeName: string | null;
}

/** Someone else changed the recipient's RSVP to an event (#802). */
export interface EventRsvpChangedPayload extends EventRefPayload {
  /** `null` when the person who changed it is not a user, and the client words it. */
  changedByName: string | null;

  status: EventParticipationStatus;
}

/** A game was nominated for an event (sent to fellow attendees). */
export interface GameNominatedPayload extends EventRefPayload {
  nominatedGameTitle: string;
  nominationId: string;
}

/** A nomination the recipient created was resolved (approved/rejected/passed/failed/short of quorum). */
export interface NominationOutcomePayload {
  eventId: string;
  nominatedGameTitle: string;
  nominationId: string;
}

/** A game was added to an event's play list. */
export interface GameAddedToEventPayload extends EventRefPayload {
  /** Tells apart two editions that share a title (#1271). */
  nominatedGameSubtitle: string | null;

  nominatedGameTitle: string;
}

/** Why a game left an event's lineup (#769). */
export const LineupRemovalReason = {
  /**
   * Taken off through the removal route by a host-level role: the host, a
   * co-host, an event moderator, or a household owner or admin on a
   * household event.
   */
  TakenOut: 'TakenOut',
  /** The attendee supplying it left the event: removed, or not attending. */
  SupplierLeft: 'SupplierLeft',
  /** A write to the event's dates put its lineup ahead again, with nobody bringing the game. */
  NobodyBringing: 'NobodyBringing',
  /** The attendee supplying it removed the game from their collection (#1221). */
  RemovedFromCollection: 'RemovedFromCollection',
} as const;

export type LineupRemovalReason = (typeof LineupRemovalReason)[keyof typeof LineupRemovalReason];

/**
 * A game left the lineup of an event the recipient is still coming to (#769).
 * `occurrenceId` is `null` for a game in the event's own lineup.
 */
export interface GameRemovedFromEventPayload extends EventRefPayload {
  /** Tells apart two editions that share a title (#1271). */
  gameSubtitle: string | null;

  gameTitle: string;
  lineupGameId: string;
  occurrenceId: string | null;
  reason: LineupRemovalReason;
}

/** An event occurrence changed status (confirmed/declined/canceled/…). */
export interface OccurrenceChangePayload extends EventRefPayload {
  occurrenceId: string;
  occurrenceLabel: string | null;
}

/** The minimal household reference every household-domain notification carries. */
export interface HouseholdRefPayload {
  householdId: string;
  householdName: string;
}

/**
 * The invitee as the invite names them: a user only when the invite was
 * sent by id, otherwise a name or an address (#682). Carried only by payloads
 * that go to the inviter and to household owners and admins, since it can hold
 * an address.
 */
export interface InviteeAsInvitedPayload {
  inviteeEmail: string | null;
  inviteeId: string | null;
  inviteeName: string | null;
}

/** A user was invited to a household; sent to the invitee (#167). */
export interface HouseholdInviteReceivedPayload extends HouseholdRefPayload {
  inviteId: string;
  inviterName: string;
}

/** A household invite is awaiting approval; sent to household owners and admins (#167). */
export interface HouseholdInviteAwaitingApprovalPayload extends HouseholdRefPayload, InviteeAsInvitedPayload {
  inviteId: string;
  inviterName: string;
}

/** An invitee accepted and became a member of the household; sent to its other members (#682). */
export interface HouseholdInviteAcceptedPayload extends HouseholdRefPayload {
  inviteId: string;
  memberName: string;
  memberUserId: string;
}

/** An invitee declined a household invite; sent to the inviter and to household owners and admins (#682). */
export interface HouseholdInviteDeclinedPayload extends HouseholdRefPayload, InviteeAsInvitedPayload {
  inviteId: string;
}

/**
 * Household ownership moved to another member; sent to the new household
 * owner (#246). `previousOwnerName` is null when the previous household
 * owner's user was deleted before the notification was written.
 */
export interface HouseholdOwnershipTransferredPayload extends HouseholdRefPayload {
  newOwnerMemberId: string;
  newOwnerName: string;
  previousOwnerMemberId: string;
  previousOwnerName: string | null;
}

/**
 * A game was shared with the recipient by name; sent to them when the share
 * takes effect, which a share to a user does on create (#810). `sharerName`
 * is the sharer's name as it is shown, so the recipient is told who, and never
 * an address.
 */
export interface GameShareReceivedPayload {
  gameId: string;
  gameTitle: string;
  shareId: string;
  sharerName: string;
}

/**
 * A member's share of a game into a household waits for approval; sent to the
 * household owners and admins, who answer for what the household shares (#810).
 * A household share that takes effect on create tells nobody.
 */
export interface GameShareAwaitingApprovalPayload extends HouseholdRefPayload {
  gameId: string;
  gameTitle: string;
  shareId: string;
  sharerName: string;
}

/**
 * A first sign-in through a sign-in provider asked for a username that was
 * taken, so the user got the first free variant (#912). Sent to the new
 * user alone. `usernameChangeAllowed` is the server setting as it stood when
 * the notification was sent, so a client can offer the change or say it is off.
 */
export interface UsernameVariantAssignedPayload {
  requestedUsername: string;
  username: string;
  usernameChangeAllowed: boolean;
}

/**
 * The outcome of the test email an admin asked for (#654), sent to that admin
 * alone. `code` is the stable failure code, `null` when the mail went; `message`
 * is the plain-language outcome as a `t()` marker, which `I18nResponseInterceptor`
 * renders in the reader's language on `GET /notifications/unread`.
 */
export interface MailTestResultPayload {
  code: MailFailureCode | null;
  message: I18nMessage;
  outcome: 'sent' | 'failed';
}

/**
 * The single source of truth mapping every `NotificationType` to its payload
 * shape. Keyed by the enum value, so `NotificationPayloadMap[T]` resolves a
 * type's payload and the discriminated `UnreadNotificationDto` / typed
 * `create()` derive from here. Adding a `NotificationType` without a payload
 * here is caught by {@link _assertPayloadMapExhaustive} below.
 */
export type NotificationPayloadMap = {
  [NotificationType.AuditUnattributedEvent]: AuditUnattributedEventPayload;
  [NotificationType.DataGatewayAutoDisabled]: DataGatewayAutoDisabledPayload;
  [NotificationType.DataGatewayCapabilitiesLost]: DataGatewayCapabilitiesLostPayload;
  [NotificationType.EventAttendeeRemoved]: EventRefPayload;
  [NotificationType.EventCancelled]: EventCancelledPayload;
  [NotificationType.EventCreated]: EventRefPayload;
  [NotificationType.EventDeleted]: EventRefPayload;
  [NotificationType.EventInviteAccepted]: EventInviteAnsweredPayload;
  [NotificationType.EventInviteDeclined]: EventInviteAnsweredPayload;
  [NotificationType.EventInviteReceived]: EventInviteReceivedPayload;
  [NotificationType.EventOccurrenceCanceled]: OccurrenceChangePayload;
  [NotificationType.EventOccurrenceConfirmed]: OccurrenceChangePayload;
  [NotificationType.EventOccurrenceDeclined]: OccurrenceChangePayload;

  // Occurrence lifecycle — Confirmed/Canceled/Declined are emitted today;
  // Proposed/Rescheduled are not yet, but share the same shape.
  [NotificationType.EventOccurrenceProposed]: OccurrenceChangePayload;

  [NotificationType.EventOccurrenceRescheduled]: OccurrenceChangePayload;
  [NotificationType.EventReopened]: EventRefPayload;
  [NotificationType.EventRsvpChanged]: EventRsvpChangedPayload;
  [NotificationType.EventRsvpReceived]: EventRsvpReceivedPayload;
  [NotificationType.ExpansionImported]: GameImportedPayload;
  [NotificationType.GameAddedToEvent]: GameAddedToEventPayload;
  [NotificationType.GameImported]: GameImportedPayload;
  [NotificationType.GameNominated]: GameNominatedPayload;
  [NotificationType.GameNominationApproved]: NominationOutcomePayload;
  [NotificationType.GameNominationFailed]: NominationOutcomePayload;
  [NotificationType.GameNominationPassed]: NominationOutcomePayload;
  [NotificationType.GameNominationQuorumNotMet]: NominationOutcomePayload;
  [NotificationType.GameNominationRejected]: NominationOutcomePayload;
  [NotificationType.GameRemovedFromEvent]: GameRemovedFromEventPayload;
  [NotificationType.GameShareAwaitingApproval]: GameShareAwaitingApprovalPayload;
  [NotificationType.GameShareReceived]: GameShareReceivedPayload;
  [NotificationType.HouseholdInviteAccepted]: HouseholdInviteAcceptedPayload;
  [NotificationType.HouseholdInviteAwaitingApproval]: HouseholdInviteAwaitingApprovalPayload;
  [NotificationType.HouseholdInviteDeclined]: HouseholdInviteDeclinedPayload;
  [NotificationType.HouseholdInviteReceived]: HouseholdInviteReceivedPayload;
  [NotificationType.HouseholdOwnershipTransferred]: HouseholdOwnershipTransferredPayload;
  [NotificationType.ImportFailed]: ImportFailedPayload;
  [NotificationType.MailTestResult]: MailTestResultPayload;
  [NotificationType.MediaContributionReclaimExpired]: MediaContributionReclaimExpiredPayload;
  [NotificationType.MediaContributionRejected]: MediaContributionRejectedPayload;
  [NotificationType.UsernameVariantAssigned]: UsernameVariantAssignedPayload;
  [NotificationType.WatchedExpansionImported]: WatchedExpansionImportedPayload;
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
 * One unread notification as `UserNotificationsService.getUnread` (`@bge/notifications`)
 * returns it — a discriminated union on
 * `type`, so a consumer that narrows `type` gets the exact `payload` shape. A
 * `t()` marker in a payload (`ImportFailedPayload.error`) is still a marker
 * here; `I18nResponseInterceptor` renders it to a string on the way to the client.
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

/**
 * One notification as `UserNotificationsService.list` (`@bge/notifications`)
 * returns it for the history list: {@link UnreadNotificationDto}'s shape plus
 * `readAt`, which is `null` while the notification is unread. The history holds
 * read and unread notifications alike, so a client can show when each was read
 * (#1597).
 */
export type NotificationDto = UnreadNotificationDto & { readAt: Date | null };
