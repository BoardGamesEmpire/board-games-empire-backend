import type { NominationStatus } from '@bge/database';

export interface NominationCreatedEvent {
  eventId: string;
  gameId: string;
  nominatedByAttendeeId: string;
  nominationId: string;
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
  gameId: string;
  nominationId: string;
  status: NominationStatus;
}

export interface GameAddedToEventPayload {
  addedByAttendeeId: string;
  eventGameId: string;
  eventId: string;
  gameId: string;
}
