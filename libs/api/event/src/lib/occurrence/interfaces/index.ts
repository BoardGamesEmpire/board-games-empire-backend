import type { AvailabilityResponse, OccurrenceStatus } from '@bge/database';

export interface OccurrenceAddedEvent {
  eventId: string;
  occurrenceId: string;
  status: OccurrenceStatus;
}

export interface OccurrenceStatusChangedEvent {
  eventId: string;
  occurrenceId: string;
  previousStatus: OccurrenceStatus;
  newStatus: OccurrenceStatus;
}

export interface AvailabilityVoteSubmittedEvent {
  eventId: string;
  occurrenceId: string;
  attendeeId: string;
  response: AvailabilityResponse;
}

/** Event-level attendee context shared across all occurrences. */
export interface AttendeeContext {
  /** Total EventAttendee records (registered + guests) */
  total: number;
  /** Attendees with a userId — can cast availability votes */
  registered: number;
  /** Attendees without a userId — cannot vote */
  guests: number;
  /** Breakdown by RSVP status */
  byStatus: {
    attending: number;
    invited: number;
    maybe: number;
    notAttending: number;
  };
}

/** Aggregated availability for a single occurrence. */
export interface AvailabilitySummaryEntry {
  occurrenceId: string;
  label: string | null;
  startDate: Date | null;
  endDate: Date | null;
  status: OccurrenceStatus;
  available: number;
  maybe: number;
  unavailable: number;
  totalVotes: number;

  /**
   * Registered attendees who have not yet voted on this occurrence
   */
  pendingVotes: number;

  /**
   * totalVotes / eligibleVoters (0 when no eligible voters)
   */
  participationRate: number;

  voters: {
    attendeeId: string;
    response: AvailabilityResponse;
  }[];
}

/** Full availability summary returned by getAvailabilitySummary. */
export interface AvailabilitySummary {
  attendees: AttendeeContext;
  /** Registered attendees who are able to cast votes (= attendees.registered) */
  eligibleVoters: number;
  occurrences: AvailabilitySummaryEntry[];
}
