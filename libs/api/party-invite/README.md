# party-invite

A party's side of an invite, of every kind the party routes serve (#742). This library serves the routes under `/api/invites`: the invites a user has received and sent, and accepting, declining and withdrawing one. Each context keeps its own routes for what its authority does with an invite, such as `/api/households/:householdId/invites` for creating, listing, revoking and approving a household's invites, and `/api/events/:eventId/invites` for an event's.

## The routes

- **`GET /api/invites`** is the inbox: the invites still open to the acting user, newest first.
- **`GET /api/invites/sent`** lists the invites the acting user sent (#751), with `?status=` for any one status as it stands now.
- **`POST /api/invites/:inviteId/accept`** and **`POST /api/invites/accept`** accept an invite by its id, or by the token from its link in the body (#163). The token never travels in the path.
- **`POST /api/invites/:inviteId/decline`** and **`POST /api/invites/decline`** decline one the same two ways (#164).
- **`POST /api/invites/:inviteId/withdraw`** lets the inviter take back an invite they sent (#164). Withdraw is not revoke: revoking an invite someone else sent is the context's route.

## Who may call them

Only a person signed in as themself. Joining a household or an event, or turning down or taking back an invite, is that person's own act (#276), so an API key, which acts for its owner but is not the owner, is refused with 403, and so is every other actor but a session user. No CASL grant on `Invite` stands behind these routes: `@bge/invites` binds every party read to the acting user in its query (#161), so a stranger addressing someone else's invite meets a 404.

## How an action reaches its context

`PartyInviteService` reads the invite's type with `InviteService.findPartyTypeWithin`, bound to the acting user as a party, in a short transaction of its own. It then hands the invite to the `InviteResponder` for that kind, which owns what moving it means for its context:

- A household invite goes to `HouseholdInviteResponder`, which admits a household member on accept.
- An event invite goes to `EventInviteResponder`, which seats an attendee on accept, `Attending`, in the role the invite offered. Someone a host removed earlier has their attendee row revived.

Every kind the party routes serve has a responder, and the service picks it by a lookup keyed by kind, so a kind added to `CONTEXTUAL_INVITE_TYPES` without one fails to compile rather than meeting a 404 at runtime. An accept answers `{ message, type, invite, ... }`, with `member` for a household invite and `attendee` for an event invite. An invite of a kind no party route serves meets the same 404 a stranger meets.

## The lists

Each list is an `OR` of one `where` arm per kind of invite, and each arm comes from the library that owns that context, which decides which of its invites a user may see there: `receivedHouseholdInviteWhere` and `sentHouseholdInviteWhere`, and `receivedEventInviteWhere` and `sentEventInviteWhere`. Every kind has an arm, by the same compile-time rule. `?type=` keeps one arm, and a kind no party route serves (`System`, `Campaign`) is a 400. Each row carries its `type`, and the context it is into: `household { id, name }` or `event { id, title }`, the other `null`.

## Dependencies

This library imports `@bge/household` and `@bge/event` for their responders and their list arms, by #742's decision. Neither imports this library, so there is no cycle. Ask before adding another feature-library import.

## Running unit tests

Run `npm run nx -- test @board-games-empire/party-invite` to execute the unit tests via [Jest](https://jestjs.io).
