import type { AvailabilityResponse, OccurrenceStatus } from '@bge/database';

/** Event-level attendee context shared across all occurrences. */
export interface AttendeeContext {
  /** Total EventAttendee records (registered + guests), without the ones a host removed */
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
  /** Votes that count: from attendees who are in the event and whose event role can vote on dates */
  totalVotes: number;

  /**
   * Eligible voters who have not yet cast a vote that counts on this occurrence
   */
  pendingVotes: number;

  /**
   * totalVotes / eligibleVoters (0 when no eligible voters)
   */
  participationRate: number;

  /** Every vote, the ones that do not count included, each marked (#551) */
  voters: {
    attendeeId: string;
    response: AvailabilityResponse;
    /**
     * False when the voter is not attending, or their event role can't vote
     * on dates (#759); the counts above leave the vote out
     */
    eligible: boolean;
  }[];
}

/** Full availability summary returned by getAvailabilitySummary. */
export interface AvailabilitySummary {
  attendees: AttendeeContext;
  /**
   * Registered attendees whose votes count: the ones not marked NotAttending,
   * whose event role can vote on dates (#759)
   */
  eligibleVoters: number;
  occurrences: AvailabilitySummaryEntry[];
}
