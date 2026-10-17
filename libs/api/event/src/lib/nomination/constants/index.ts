export enum NominationEvent {
  NominationCreated = 'event.nomination.created',
  NominationWithdrawn = 'event.nomination.withdrawn',
  VoteCast = 'event.nomination.vote_cast',
  NominationResolved = 'event.nomination.resolved',
  NominationPaused = 'event.nomination.paused',
  NominationResumed = 'event.nomination.resumed',
  GameAddedToEvent = 'event.game.added',
  GameRemovedFromEvent = 'event.game.removed',
}
