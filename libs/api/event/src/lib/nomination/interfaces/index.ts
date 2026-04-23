import type { NominationStatus } from '@bge/database';

export interface NominationCreatedEvent {
  eventId: string;
  nominatedByAttendeeId: string;
  nominationId: string;
  platformGameId: string;
}

export interface VoteCastEvent {
  attendeeId: string;
  eventId: string;
  nominationId: string;
  voteType: string;
}

export interface NominationResolvedEvent {
  elevatedToEventGameId: string | null;
  eventId: string;
  nominationId: string;
  platformGameId: string;
  status: NominationStatus;
}

export interface GameAddedToEventPayload {
  addedByAttendeeId: string;
  eventGameId: string;
  eventId: string;
  platformGameId: string;
}
