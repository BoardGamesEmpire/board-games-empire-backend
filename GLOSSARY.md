# Board Games Empire

The Board Games Empire backend, which serves game data to households and draws that data from external sources.

## Language

### Servers

**Server**:
One running copy of Board Games Empire, with its own users, households and data.
_Avoid_: instance, installation, deployment, site, system, global

**Process role**:
The part of a server a single process runs: api, worker, gateway worker or coordinator.
_Avoid_: role on its own, deployment role, service

**Deployment profile**:
A ready-made way to run a whole server: split, with each process role in its own container, or, planned, all-in-one.
_Avoid_: profile on its own (a user's profile), topology, combined deployment

**BGE image**:
The one container image that every process role runs from, with each remote DataGateway shipping as an image of its own.

**Bootstrap**:
The work a process does at start, before it serves anything, such as applying migrations and seeding reference data. Connecting to DataGateways at start is not part of it.
_Avoid_: boot sequence, init

**Database role**:
A login on the database a server keeps its data in, holding only the privileges granted to it. Every process role connects as one.
_Avoid_: role on its own, database user

**Migration credential**:
The database role, and the way to reach it, that bootstrap applies migrations with: the one every process role connects as, unless a server gives its migrations one of their own.
_Avoid_: migration user, admin connection

**Gateway worker**:
The process role that does a server's DataGateway work in the background, such as fetching games to import.
_Avoid_: gateway-fetch, fetcher

**Coordinator**:
The process role that carries live DataGateway traffic for the api, such as searches, fetching one game and starting imports. The api, not the coordinator, keeps the DataGateway records.

**Worker**:
The process role that runs a server's background jobs.
_Avoid_: worker on its own for the gateway worker, any other job consumer, or a plugin's separate-process execution mode

**Job**:
The server's record of one piece of background work, such as an import: who or what started it, how far it has got and how it ended.

**Recurring job**:
A job the server runs again and again on a schedule, as opposed to a one-off job.
_Avoid_: scheduled job (a one-off job can be scheduled too)

**Server release**:
A published build of the server software.
_Avoid_: release on its own (a release belongs to a game's edition)

**Release channel**:
A named track releases are published on, telling how settled they are. Server releases and plugin releases keep their own channel names, such as edge for the server and beta or stable for plugins.
_Avoid_: channel on its own, image channel

**Setting**:
Anything a user or admin changes in the app: a user setting, a system setting or a plugin setting.
_Avoid_: preference, configuration

**Configuration**:
What an operator sets in a server's environment before it starts.
_Avoid_: settings, for the environment

**Operator**:
The person who runs a server's infrastructure, outside the app.
_Avoid_: self-hoster; operator for anyone acting inside the app (say staff or server admin)

**Outbound HTTP policy**:
The server-wide rules on which outside addresses webhooks, plugins and other outbound requests may contact. Some addresses stay blocked whatever the policy says.
_Avoid_: SSRF policy, egress policy, outbound policy; network policy (the infrastructure firewall)

**Retention**:
How long a kind of record is kept before it is removed. It doesn't say how: some records are deleted, others only hidden.
_Avoid_: retention to mean deletion, expiry

**Domain event**:
A notice that something happened on the server, announced to whatever listens for it.
_Avoid_: event on its own (an event is a gathering)

**Auto-disable**:
Switching something off automatically after repeated failures, such as a DataGateway, a webhook subscription or a crashing plugin.
_Avoid_: disabled on its own (disabling is a deliberate switch)

### Server setup

**First-run setup**:
The planned guided flow a new server shows whenever its state calls for it, such as having no Owner or no DataGateway yet: choosing how the first people get in, and adding the first DataGateways.
_Avoid_: onboarding, onboarding wizard, setup wizard

**Server onboarding**:
The client's flow for finding a server, checking that its version is compatible, and adding it to the app.
_Avoid_: onboarding on its own

**Server identity**:
The permanent, unique identifier a server gives itself when it is first set up, so that clients can tell servers apart.

**Server discovery**:
What a server tells a client about itself before anyone signs in: its identity, its name and the ways to sign in. A fuller view for signed-in users is planned.
_Avoid_: tier 1 and tier 2 discovery

### People

**User**:
Any identity on a server: a registered user, an anonymous user, or the service account.
_Avoid_: account

**Registered user**:
A person with a full account on a server.
_Avoid_: human user, person

**Anonymous user**:
A temporary identity for someone taking part without registering, such as a person invited to an event.
_Avoid_: guest, account-less user; anonymous for a request that carries no identity (say unauthenticated)

**Service account**:
The server's own built-in user, which nobody can sign in as. It owns what belongs to the server rather than to a person, such as imported games and contributed media.
_Avoid_: system user, service principal; system actor (the service account owns, the system actor acts)

**Sign-in method**:
One way a registered user can sign in, such as a password or a linked external provider.
_Avoid_: account

**Session**:
A signed-in period of use by a registered or anonymous user.
_Avoid_: session for a play or a search

**Provisioning**:
What the server does for a newly signed-up user: giving them their starting role and profile, and settling whether they are the server's first person.
_Avoid_: onboarding, setup, registration (for this after-signup step)

**Owner election**:
The one-time step that makes the first person to sign up on a new server its Owner, at the same moment the server creates its service account.
_Avoid_: first signup, first account, system birth, downlevelling

**Display name**:
The name a user chooses to be shown by, separate from their unique username; it starts out as their first and last name.
_Avoid_: full name, name on its own

**Profile**:
What a user shows others about themselves, such as about-me details and the games and ways of playing they like. Their settings are separate.
_Avoid_: external profile (for an account at another service)

**Avatar**:
The picture that represents a user, set on their profile. A sign-in provider's picture only seeds it.
_Avoid_: image, profile picture

**Searchable**:
Whether other users can find someone in user search, separately from who may see their profile.
_Avoid_: discoverable (kept for households)

**Guardian**:
Planned: a person who may give or withhold consent on behalf of one particular minor. It is a relationship between two people, not a household role.
_Avoid_: household admin as a stand-in for guardian; capacity for legal capacity (it names an event's headcount)

**Invite**:
An offer to join a household, an event, a campaign or the server, which the invitee accepts or declines.
_Avoid_: invitation; invite for an attendee's RSVP state (say invited)

**Ban**:
A user being barred from a server, for a time or for good. A qualified ban, such as a feedback ban, or a planned chat or game-creation ban, bars them from one activity only.
_Avoid_: banned for the service account's sign-in lock (say cannot sign in)

### Friends and sharing

**Friendship**:
The single relationship between two users, from the first friend request through acceptance or refusal. Two users have at most one, whichever of them asked.
_Avoid_: friend relationship, connection

**Friend**:
A user whose friendship with you has been accepted. Only friends count for anything shown to friends.
_Avoid_: contact

**Friend request**:
One user asking to become another's friend, which the other accepts or declines and the asker may withdraw first. Users can choose not to receive requests at all.
_Avoid_: invite (for friends); sender and recipient (say requester and addressee)

**Friends of friends**:
Planned: users two friendship steps away from you, as a reach between friends and everyone.
_Avoid_: second degree

**Block**:
One user shutting out another, whether or not they are friends.
_Avoid_: blocked friendship

**Reach**:
How far from its owner an item can be seen: only the owner, friends, friends of friends, or everyone. The four form a ladder, each rung reaching everyone the rung below it does.
_Avoid_: visibility

**Share**:
A named user or household that an item is also shown to, whatever its reach.
_Avoid_: visibility

### Roles and permissions

**Role**:
A named set of permissions held on a server, in a household or at an event.
_Avoid_: role for the part of a server a process runs (say process role), or for a database login (say database role)

**Role scope**:
Where a role applies: the whole server, one household or one event.
_Avoid_: scope on its own

**Server role**:
A role that applies across the whole server, such as Owner, Admin or User.
_Avoid_: global role, system role

**Base role**:
The server role an identity starts with: User for a registered user, AnonymousUser for an anonymous one. Other server roles are added on top.
_Avoid_: everyone role, baseline user, plain user

**Scoped role**:
A role a user holds within one household or one event, whose permissions reach only that household or event. Household roles and event roles are scoped roles.
_Avoid_: membership role, attendee role

**Owner**:
The server-wide role with full control of a server. Every other owner is qualified: household owner, key owner, owner of a record.
_Avoid_: system owner, site owner, server owner; owner on its own for anything but this role

**Staff**:
Holders of the Admin or Moderator role.
_Avoid_: admins, elevated (which includes the Owner)

**Server admins**:
Holders of the Owner or Admin role, who install plugins and decide server-wide consent.
_Avoid_: admins on its own

**Moderator**:
A server-wide role for keeping content in order: it can read everything and remove or correct content, but cannot change the server's settings.
_Avoid_: moderator on its own for the event role (say event moderator)

**Elevation**:
Gaining a server role on top of the base role, never in place of it. An elevated user holds the Owner, Admin or Moderator role.
_Avoid_: promotion; elevation for a nomination joining an event's lineup (say added to the lineup)

**Custom role**:
Planned: a role defined on a running server rather than shipped with the code.
_Avoid_: user-defined role

**Permission**:
A named right to perform an action on one kind of resource. A condition can narrow which records it reaches, and a field list which parts of a record.
_Avoid_: rule, grant (for the permission itself), scope

**Permission slug**:
A permission's stable, readable name, made of its action, its resource type and sometimes a qualifier that says how it is narrowed.
_Avoid_: permission code, permission key

**Resource type**:
A kind of record that permissions are written against, such as games or households.
_Avoid_: subject, outside code

**Core permission**:
A permission that ships with the server, as opposed to a declared permission, which a plugin defines for its own features. Plugins request core permissions to act on the server's data.
_Avoid_: system permission, catalog permission, external permission check

**Condition**:
The part of a permission that limits which records it reaches, usually by tying it to the acting user or to the household or event a role belongs to.
_Avoid_: ABAC, filter, template, bounding condition

**Grant**:
Access actually conferred: an allowance that a role holds or that a user is given directly, or a granted consent decision. A denial is never a grant.
_Avoid_: grant for a consent decision that refuses

**Denial**:
A permission that forbids instead of allowing. Among one user's direct permissions, a denial beats a conflicting allowance; a direct permission, allowance or denial, beats what the user's roles say.
_Avoid_: inverted permission, inverse denial, cannot rule; denial for a unit refusing a plugin's permission (that is a durable denial)

**Direct permission**:
A permission or denial given to one user outright rather than through a role. It can be limited to one record and can expire.
_Avoid_: override, per-user override, direct grant, user permission

**Risk level**:
How dangerous a permission is to hand over: low, medium, high or critical. It decides how prominently the permission is shown when consent is asked, and whether consent must be given again when the level rises.
_Avoid_: severity, sensitivity

**Retired permission**:
A core permission that a newer version of the server has dropped. It is kept so its name is never reused, but confers nothing, even through roles or keys that still list it.
_Avoid_: tombstone, deleted permission

**Fail-open grant**:
A scoped role holding a permission with no condition, so it reaches every matching record on the server rather than only its own household or event.
_Avoid_: unconditioned scoped grant

**Inert grant**:
A role holding a permission whose condition depends on something that role never supplies, so it matches nothing while appearing to grant something.
_Avoid_: fail-closed grant, dead grant; decorative grant (a related defect: a grant no route exercises)

**Permission catalog**:
The full set of permissions and roles a server knows, brought up to date at every start.
_Avoid_: catalog on its own, manifest

**Managed by**:
Who maintains a permission catalog entry: shipped with the server, edited on the server, or added by a plugin.
_Avoid_: owner, Admin, provenance

### Actors and access

**Actor**:
Whoever is responsible for the operation in progress, as the server sees it for both permission checks and the audit log. An actor is a user, an API key, a plugin, the server itself, or an outside system.
_Avoid_: principal, caller

**Acting user**:
The user an actor's actions are attributed to: the user themselves, or the owner of an API key. The server itself, outside systems and plugins have no acting user today.
_Avoid_: owning user, triggering user, scope subject

**System actor**:
The actor for work the server does on its own with nobody behind it, such as recurring jobs, bootstrap and clean-ups. It always states its reason and holds unrestricted authority.
_Avoid_: service account (that is a user), system user

**External actor**:
Planned: an outside system, such as a DataGateway calling in, that is identified for the audit log but holds no authority of its own.
_Avoid_: gateway actor

**Plugin actor**:
The identity a running plugin acts under: the plugin itself plus the consent unit it is acting for. It carries only the authority consented to that plugin, and whoever triggered the work lends it none.
_Avoid_: plugin user, delegated user, on behalf of the user

**Trigger**:
The actor whose action set a plugin running, recorded for attribution only and lending the plugin no authority. Following triggers back through nested plugin runs always ends at an actor that is not a plugin, the originating actor.
_Avoid_: triggering or originating actor for work with no plugin in it (such as a queued job); originating principal

**Attribution**:
Recording which actor caused a change. A change recorded with no actor is unattributed, which is always a bug, so the server reports it instead of passing it off as its own work.
_Avoid_: anonymous change, system change

**Ceiling**:
The largest set of records an actor's permissions let it see or change for one resource type. A list read's own intrinsic scope is always narrowed to fit under it.
_Avoid_: ability conditions, authorization filter; ceiling for a quota's limit

**Intrinsic scope**:
The set of things a list read is about, such as "my households", set by that list itself and separate from what the actor may see.
_Avoid_: list scope, membership scope

**Unscoped read**:
A list read that deliberately has no intrinsic scope because its contents are the same for everyone. It must say why, and the actor's ceiling still limits it.
_Avoid_: global list, unfiltered read

**API key**:
A credential a user creates so that a program can act as them. It can do only what both its owner and its key scopes allow, and it stops working while its owner is banned.
_Avoid_: token, delegation

**Key scope**:
The permissions one API key is limited to. A key with no scopes can do nothing that needs a permission.
_Avoid_: key permission

**Impersonation**:
A staff member acting as another user through that user's own session. It is deliberately blocked, both to start and to use, until there is a decision on how it would be audited.
_Avoid_: act as user (a different, superseded idea)

### Quotas and audit

**Quota**:
A limit on how much of something may exist, such as members per household, webhook subscriptions per user or storage used. Where no quota is set there is no limit.
_Avoid_: cap, plan; limit (for the rule itself; the limit is its number)

**Quota scope**:
What a quota applies to: the whole server, one household, one membership or one user. Each scope that applies is checked on its own, so a household can tighten a server-wide limit but never raise it.
_Avoid_: level, tier

**Quota resource**:
The thing a quota counts, such as household members, webhook subscriptions, storage used or plugins installed. Some are defined before anything can measure them.
_Avoid_: metric, quota key

**Default quota**:
A quota that applies to every household, membership or user that has no quota of its own.
_Avoid_: type-level default, wildcard

**Soft overage**:
Going over a quota that is set to warn rather than block: the action goes ahead and a warning is raised, where a hard limit would block it.
_Avoid_: soft cap, soft limit

**Audit log**:
The server's record of every change made to its data: what changed, who or what made it, and when. One record in it is an audit entry.
_Avoid_: audit row, audit event; audit log for a single entry

### Households

**Household**:
A trust group of any size whose members share their games and plan play together. Living together is not required.
_Avoid_: family (a group of related games), home

**Membership**:
A user's belonging to a household. Whoever holds one is a member, whatever their household role.
_Avoid_: member, for the record

**Household role**:
A member's standing in one household, which decides how much of it they can manage.
_Avoid_: household permission level

**Member role**:
The household role for regular members, above a household guest and below a household admin.

**Founder**:
The user who created a household. They start as its owner, but the title records history, not current authority.
_Avoid_: creator, created by

**Roster**:
The list of a household's members and their household roles; anyone who can see a household can see its roster.
_Avoid_: member list

**Ownership transfer**:
A household owner handing ownership to another member in one step: the member becomes an owner and the one handing over becomes a household admin. After a household is created, it is the only way anyone gains or loses ownership.
_Avoid_: promote to owner, change role to owner

**Last owner**:
A household's only remaining owner, who cannot leave or be removed until they transfer ownership.
_Avoid_: sole owner

**Admission**:
A user becoming a member of an existing household, which always takes that user's own act: accepting an invite, or asking to join and being approved. Nobody is added without agreeing.
_Avoid_: add member, admin adds; join as the general word (joining is one path)

**Membership origin**:
How a member came to belong to a household: they founded it, accepted an invite, or were approved after asking to join.
_Avoid_: consent path, provenance

**Join policy**:
Which ways into a household are open to people outside it.

**Member invite policy**:
A household setting that decides how holders of the member role may invite: directly, only once a household owner or admin approves each invite, or not at all. A household's owners and admins always invite directly, and its guests never do.

**Join request**:
Planned: a user asking to join a household, which its owners or admins approve or deny.
_Avoid_: application

**Discoverability**:
Whether people outside a household can find it.
_Avoid_: visibility

**Restore window**:
The 30 days after a household owner deletes a household, during which any of its owners can undo the deletion. After that, or after a deletion by staff, only staff can restore it.
_Avoid_: recovery grant (the permission behind it), grace period

**Game pool**:
The games a household's members share with each other.
_Avoid_: pool on its own, household pool

**Collection sharing**:
A member's choice to put their games into a household's game pool. It is on by default, and single games can be held back as excluded games. It works apart from reach: a shared game is in the game pool even when its collection entry reaches only the owner.
_Avoid_: show all games

**Excluded game**:
One of a member's games that they hold back from one household's game pool while still sharing the rest.
_Avoid_: hidden game, opt-out; exclusion on its own (see Categorical exclusion)

### Events

**Event**:
A gathering to play games, such as a game night.
_Avoid_: event for something that happened on the server (say domain event)

**Event type**:
What kind of gathering an event is, such as family night, strategy night or adults only, so people can decide whether to come.
_Avoid_: game night type; game night for events in general

**Host**:
The person running an event. An event can also have co-hosts.
_Avoid_: host for the server as a plugin or DataGateway sees it (say the server)

**Event role**:
An attendee's part in an event, such as host, co-host, organizer or spectator, each allowing different actions.
_Avoid_: attendee role

**Recurring event**:
A planned series of separate events generated from a template, such as a weekly game night.
_Avoid_: occurrence, for one event in the series

**Occurrence**:
One scheduled date of an event: its single date, one day of a multi-day event, or a date proposed while attendees vote on availability.

**Scheduling mode**:
How an event's dates are settled: one fixed date, several fixed dates, or an availability poll.
_Avoid_: event mode

**Availability poll**:
Settling an event's dates by proposing several and letting attendees answer available, maybe or unavailable for each, after which the host confirms or declines each proposal. One attendee's answer is an availability vote.
_Avoid_: date poll, scheduling poll

**Attendee**:
Anyone on an event's list, whatever their RSVP.
_Avoid_: participant (an event role), invitee

**RSVP**:
An attendee's answer to an event: attending, maybe, or not attending. Before answering they are simply invited.
_Avoid_: participation status, attendee status; confirmed (to mean attending)

**Event policy**:
An event's rules: who may invite, how many may come, which games are allowed, how games get chosen and how voting works. An occurrence can override any of them for its day.
_Avoid_: event settings, event rules

**Capacity**:
The most people an event will take, with or without spectators, and whether that limit is strict.
_Avoid_: capacity for a person's legal capacity to consent

**Venue**:
Where an event or a play takes place.
_Avoid_: location

**Offered games**:
The games an attendee offers to bring to an event.
_Avoid_: game list, attendee pool, pool

**Supplier**:
The attendee who will bring a given game to an event.
_Avoid_: supplied from, brought by; owner (whoever nominates a game need not own it)

**Nomination**:
An attendee's proposal that an event play a particular game from those its attendees have offered. Depending on the event's game addition mode, it is added at once, goes to a vote, or waits for the host.
_Avoid_: suggestion

**Game addition mode**:
An event's rule for how games get chosen: anyone adds directly, nominations go to a vote, nominations need the host's approval, or only hosts add games.
_Avoid_: nomination mode

**Game vote**:
An attendee's vote on a nomination: for, against, or interested. The event's rules decide whether "interested" counts as for, against, or not at all.
_Avoid_: ballot; availability vote (a different thing)

**Vote threshold**:
How much support a nomination needs to pass: a simple majority, a set percentage, everyone, or a fixed number of votes for.
_Avoid_: pass mark

**Vote eligibility**:
Which attendees may vote on nominations: everyone on the list, only those attending, or only those offering games.
_Avoid_: confirmed (to mean attending), pool participants

**Quorum**:
How many of an event's eligible voters must vote before a vote's result stands.
_Avoid_: percent of attendees

**Lineup**:
The games an event has settled on playing.
_Avoid_: suggested games, scheduled games, confirmed games, event games

**Primary game**:
One of the main games in an event's lineup.
_Avoid_: main game

**Filler game**:
Planned: a short game, up to a set length, played between an event's primary games or while waiting.
_Avoid_: side game

### Games

**Game**:
A title the server knows about, apart from any platform it is played on: Catan, not Catan on PlayStation 5. Expansions, accessories and bundles are games too, told apart by their content type.
_Avoid_: game record, title (that is only its name)

**Game catalog**:
Every game a server knows about.
_Avoid_: catalog on its own, catalogue, game library

**Base game**:
A game that stands on its own and that expansions, DLC and other add-ons attach to.
_Avoid_: parent game, main game

**Imported game**:
A game brought in from a DataGateway. It belongs to the server, and everyone can see it.

**Manual game**:
A game a registered user creates by hand. Every registered user can create one unless banned from it.
_Avoid_: game creation request (creating a game is not a request)

**Game merge**:
Planned: combining two games that turn out to be the same title, usually spotted when a game imported from one DataGateway resembles one imported from another, so that a single game is linked to both.
_Avoid_: dedup (that names matching taxonomy and platforms on import)

**Frozen**:
Describes a game, or a record attached to it, that is locked so later imports cannot overwrite its data. Imports already leave frozen records alone; a way to freeze one is planned.
_Avoid_: locked, pinned

**Edition**:
A distinct published form of a game, such as a deluxe or game-of-the-year edition.

**Release**:
An edition's availability in one region.
_Avoid_: version, for games

**Platform**:
What a game is played on: tabletop, or hardware such as PC, PlayStation 5 or Xbox Series X.
_Avoid_: platform for a store

**Store**:
Where a digital copy of a game is sold, such as Steam or the PlayStation Store. A store is never a platform: Catan bought on Steam is a PC game.
_Avoid_: storefront, shop

**Platform game**:
One game on one platform, such as Catan on PC. It is what users collect, bring to events and play.
_Avoid_: platform incarnation, PG

**Platform type**:
The broad class of platform a game is played on, such as tabletop, console, PC or mobile.

**Content type**:
What a game is in relation to other games, such as a base game, expansion, DLC, accessory or bundle.
_Avoid_: game type; not to be confused with content format

**Override**:
A value set at a narrower level that replaces the broader one: a release's over its platform game's, and a platform game's over its game's. A user's customization overrides for that user only.
_Avoid_: override for an expansion's adjustments, which add rather than replace; override for a direct permission

**Credit**:
A person or company credited on a game: a designer, artist or publisher.
_Avoid_: person (publishers are companies), contributor, creator

**Required component**:
Planned: equipment a game needs to be played but does not include, such as a standard deck of cards, dice, or pencil and paper.
_Avoid_: component on its own (it also names a kind of artwork credit)

**Play mode**:
A way a game can be played on a platform, such as solo, local, online, asynchronous or real-time.
_Avoid_: capability, platform feature

**Play time**:
How long a game is expected to take, as a range. A source may also give a typical play time.

**Game length**:
A named band of play time, such as short or long, that a user can pick as the length they prefer.

### Describing games

**Taxonomy**:
The shared labels that describe what a game is like: its mechanics, categories and families.
_Avoid_: game details, metadata

**Mechanic**:
A rule pattern a game is built on, such as worker placement or deck building.
_Avoid_: mechanism

**Category**:
A label for what kind of game something is, such as a genre.
_Avoid_: genre; category on its own for anything else (say plugin category, feedback category, document kind, house-rule area)

**Family**:
A named group of related games, such as a series.
_Avoid_: collection (a user's owned games)

**Tag**:
A label users put on a game, which everyone sees. Who added it is recorded only as attribution.
_Avoid_: tag for a category from a DataGateway

**Complexity**:
How hard a game is to learn and play, on a scale of 1 to 5.
_Avoid_: weight

**Community rating**:
How highly a game's wider community rates it, as reported by the DataGateway it came from, together with how many ratings that rests on.
_Avoid_: average rating, Bayes rating, geek rating (forms of the same idea); rating on its own (see Personal rating)

### Owning games

**Collection**:
A user's whole set of owned games.
_Avoid_: library, shelf

**Collection entry**:
One game in a user's collection.
_Avoid_: game collection

**Medium**:
Whether a copy of a game is physical or digital, on any platform. A print-and-play file is a digital tabletop copy.
_Avoid_: format; digital for a platform other than tabletop (say video game)

**Personal rating**:
A user's own score, from 1 to 10, for a game in their collection.
_Avoid_: rating on its own (see Community rating)

**Favorite**:
A game a user has marked as a favorite among the games they own.
_Avoid_: favourite

**Top games**:
The planned ranked list of a user's favorite games on their profile, whether or not they own them.
_Avoid_: favorites, for this list

**List**:
A user's named list of games. Planned: every user has a wishlist by default.
_Avoid_: list for an attendee's offered games

**Game customization**:
A user's planned private changes to a game, such as its title or image, which only that user sees.
_Avoid_: user game customization; customization for a change everyone sees

**Game location**:
A planned named place where a user keeps games they own, such as a shelf or a home.
_Avoid_: location for where an event or play takes place (say venue)

**Removal**:
Recording that a user no longer owns a game, optionally with a reason such as sold or traded. The game stays listed as previously owned and gets its history back if the user adds it again.
_Avoid_: delete, tombstone, resurrection

**Loan**:
Planned: lending an owned game to someone, who need not have an account, recording when it went out, when it is due and came back, and its condition each way.
_Avoid_: loaned game, borrow (as the noun)

### Playing games

**Play**:
One recorded playing of a game.
_Avoid_: play session, game session, session

**Player**:
Planned: someone who took part in a play: a user, or a person without an account recorded by name.
_Avoid_: session player; guest on its own

**Play context**:
Planned: the setting a play happened in, such as casual, competitive, a tournament, a league, a convention, a demo or part of a campaign.
_Avoid_: organized event (when the play belongs to an event on the server)

**Duration**:
How long a play actually lasted.
_Avoid_: playtime, for a play

**Campaign**:
A planned long-running play-through of one game by a fixed group across many plays, such as a D&D campaign. It has its own chapters, characters and house rules, and may be run by a game master.

**House rule**:
A planned change to how a game is played that a group agrees to, which may apply only on some platforms. A change to a house rule makes a new revision.
_Avoid_: rule variant, variant; version, for a revision

### Data gateways

**Upstream**:
The external service a DataGateway draws its data from, such as BoardGameGeek or IGDB.
_Avoid_: source, provider

**DataGateway**:
What an admin adds to connect the server to an upstream, as a remote service or a plugin. It either finds games or only adds data to games the server already knows.
_Avoid_: game gateway, data source, data adapter, provider, gateway on its own (it also names WebSocket endpoints)

**Remote DataGateway**:
A DataGateway that runs as a separate service, which the server reaches over the network. The BoardGameGeek and IGDB DataGateways are remote.
_Avoid_: game gateway, gateway microservice, data adapter, tier 3

**Plugin DataGateway**:
Planned: a DataGateway installed as a plugin, rather than run as a separate service.
_Avoid_: in-process DataGateway (a plugin need not run in the server's process), registered driver

**Shared DataGateway**:
Planned: a remote DataGateway that serves many servers at once, combining their requests to a rate-limited service.
_Avoid_: community gateway

**Enabled**:
An added DataGateway that the server may use. An admin enables or disables it, and repeated failures auto-disable it.
_Avoid_: connected (each process holds its own connections); registered, for adding a DataGateway (say added)

**Ping**:
A quick check that a DataGateway is reachable and answering. Learning what the DataGateway can do is the interview's job, not the ping's.
_Avoid_: ping handshake

**Upstream account**:
A user's own account on an upstream, such as their BoardGameGeek username, used to sync their collection.
_Avoid_: gateway connection, gateway account, external profile, linked account (a sign-in method)

**Capability**:
Something a DataGateway can do that the server routes requests by: an operation it serves, or a kind of game it covers.
_Avoid_: feature (a plugin's consent grouping)

**Coverage**:
The platform types and content types a DataGateway can return.
_Avoid_: game kind

**DataGateway link**:
The pairing of a record on a server with the matching item at a DataGateway.
_Avoid_: alias, game source, gateway link, source

**External ID**:
An item's id at a DataGateway, exactly as the DataGateway gave it.
_Avoid_: external ID for the server's own id

**Interview**:
The server asking a DataGateway to describe itself: its capabilities, formats and the vocabularies it can list. Its sections load after it. It recurs over the DataGateway's life.
_Avoid_: handshake, registration, discovery, sync, language sync

**DataGateway onboarding**:
The first interview of a newly added DataGateway, together with an admin's review of whatever that interview couldn't settle.
_Avoid_: onboarding on its own, registration

**Review**:
An admin settling what the server could not settle on its own, such as which language a DataGateway's language name means. It follows any interview or import that leaves something unsettled.
_Avoid_: curation, curate; curating, for staff changing games (say editing)

**Vocabulary**:
A set of things the server and each DataGateway name in their own terms, such as languages, platforms or regions.

**Section**:
One vocabulary as a DataGateway lists it, such as its platforms. After each interview, every section the DataGateway declares and no admin has switched off loads as its own job, and the server records when it last loaded or failed.
_Avoid_: list sync, vocabulary sync

**Language code format**:
The scheme a DataGateway uses to identify languages: a BCP 47 tag, a two- or three-letter ISO 639 code, or a language's name in English or in the language itself.

**Content format**:
The form a DataGateway's free text arrives in, such as plain text, HTML or BBCode.

**Topic**:
Planned: a named stream of changes that an outside service pushes in through a plugin or DataGateway, such as a game being updated. Users can subscribe to a topic and read it as a feed, as a personal choice rather than a consent.
_Avoid_: inbound event, webhook (that is outbound), feed or subscription on their own

### Getting games in

**Game search**:
One search that looks in the game catalog and asks DataGateways at the same time, returning each DataGateway's results as they arrive. Each result says whether that game is already in the catalog.
_Avoid_: fan-out search, gateway search, search session; source (for one DataGateway's results); local, in system (say in the catalog)

**Import**:
Bringing a game from a DataGateway into the game catalog, with its platforms, releases, credits and taxonomy. If the game already has a DataGateway link to that item, its data is updated instead, unless it is frozen.
_Avoid_: upsert; fetch (that is only the first half)

**Fetch**:
Asking one DataGateway for a game's full data: the first half of an import, before the result is stored.

**Import batch**:
One import request, a base game plus any expansions chosen with it, tracked and reported as a group with one overall outcome.
_Avoid_: import flow, co-import

**Re-import**:
Fetching a game again from the DataGateway it came from.
_Avoid_: sync, re-sync, enrichment update

**Import activity**:
The public list of games a server has recently imported.
_Avoid_: imports feed

**Sync**:
Bringing a user's collection in from their upstream account, again and again over time.
_Avoid_: sync for a re-import, a refresh, the interview, or a client catching up on changes

**Refresh**:
Bringing a server's mechanics, categories or families up to date from a DataGateway.
_Avoid_: sync

**Enrichment**:
Adding to, or replacing, the data of a record the server already has, using a DataGateway other than the one the record came from. The records include games and the people and publishers credited on them.
_Avoid_: augmentation

**Game watch**:
Planned: a user's request to be told when a new expansion of a particular base game enters the game catalog, optionally importing it automatically.
_Avoid_: follow, subscription

### Languages

**Language**:
A human language as the server knows it, such as Chinese, grouping the more specific language tags under it.

**Language tag**:
A standard identifier for a language, used on data and in a user's settings.
_Avoid_: locale, for the language of data

**Language link**:
The server's record of what one DataGateway's name for a language means in the server's own terms. Links the server cannot settle on its own wait for review.
_Avoid_: gateway language link, mapping

**Unknown-language policy**:
The server's rule for a language a DataGateway reports that the server does not know: a well-formed code is added automatically, or held for review if the server requires that, and a bare name is always held for review.
_Avoid_: hybrid policy, auto-add policy

**Core languages**:
The languages every server starts with, chosen by the project to cover the languages games ship in.
_Avoid_: curated languages, curated vocabulary

**Preferred language**:
The language tag a user or household has chosen. For a user it sets the language the server answers in, and their searches ask DataGateways for it by default.
_Avoid_: display language, locale preference

**Search language**:
The language a game search asks DataGateways for. It defaults to the user's preferred language, and a client can override it.
_Avoid_: locale hint (a locale is a language the server writes in)

**Locale**:
A language a server writes its own messages in. The supported locales are those it can write; the request locale is the one picked for a request.
_Avoid_: display language, catalog locale

### Media

**Media**:
A file on the server, such as an image, video or document, together with its description.
_Avoid_: media object, for the file alone

**Game image**:
The picture that represents a game. An attached cover image wins over a platform's own picture, which wins over the DataGateway's.
_Avoid_: default image (say cover)

**Attachment**:
Media attached to a game, an event or a feedback report.
_Avoid_: link, for media

**Contribution**:
Giving a piece of media to the server so that it becomes public and owned by the server, such as a scan of a game's rulebook. Depending on the server's settings it may first wait for staff approval.
_Avoid_: donation, submission; contributor (for the uploader's credit)

**Reclaim window**:
The time after a contribution is rejected during which the contributor can take the file back. After it, a file uploaded only for that contribution is deleted.
_Avoid_: grace period, sweep, purge

**Uploader**:
The user who uploaded a piece of media, who keeps the credit for good, even after it is contributed and the server owns it.
_Avoid_: owner (for this sense: the owner is whoever controls it now)

**Media reference**:
Planned: a pointer to a document or photo that lives in another system a household already uses, such as Paperless-ngx or Immich, shown on the server without copying the file in.
_Avoid_: integration (for the reference itself)

**Storage driver**:
A pluggable place where the server keeps uploaded files, such as a local disk or, planned, S3-compatible storage.
_Avoid_: backend, store; driver on its own

### Notifications, webhooks and feedback

**Notification**:
A message inside the app to one user about something that concerns them, such as an invite, an RSVP, a nomination's outcome or a finished import, which they mark as read. Email and push delivery are planned.
_Avoid_: alert; notification for a webhook delivery

**Announcement**:
Planned: a notice from staff to a chosen audience, with acknowledgement and reminders, which the server also uses to warn of scheduled plugin updates and uninstalls.
_Avoid_: notification (a way of delivering it, not the notice)

**Webhook subscription**:
A user's standing request for the server to call a web address of theirs when chosen kinds of change happen to records they can see. Delivery stops for anything they can no longer see, and repeated failures auto-disable it.
_Avoid_: subscription on its own, hook

**Webhook event type**:
The published, versioned name of one kind of change that a webhook subscription can ask to receive, such as a household changing owner.
_Avoid_: event type on its own, webhook event

**Webhook audience**:
Whether a webhook subscriber can still read the record a delivery is about.
_Avoid_: visibility

**Feedback report**:
A bug report, crash report or feature request a user sends from the app. The server keeps it and forwards it to its sinks, and staff move it through statuses such as acknowledged, in progress and resolved.
_Avoid_: feedback as a countable noun, ticket; issue (the copy made in an outside tracker)

**Sink**:
A place feedback reports are forwarded to, such as the server's own database or, planned, an issue tracker or chat channel; choosing sinks per household is planned too.
_Avoid_: driver, destination

**Forwarding**:
Sending one feedback report to one sink, which succeeds or fails on its own.
_Avoid_: submission (the user submits the report); delivery (a webhook word)

**Redaction**:
Removing sensitive details, such as email addresses, tokens or fields the user chose to strip, from a feedback report before the server keeps it.
_Avoid_: sanitization

**Triage**:
Planned: staff reviewing a feedback report and moving it through its statuses.
_Avoid_: processing

### Plugins

**Plugin**:
A package of code installed on a server to add one kind of functionality. It acts with the authority consented to it, never by borrowing the authority of whoever triggered it.
_Avoid_: extension, integration; driver (a plugin may provide one)

**Plugin author**:
The person or group who writes and releases a plugin.
_Avoid_: publisher (a game credit), vendor

**Plugin manifest**:
A plugin's own description of itself, shipped with it: who it is, its category, its features, the permissions it requests and declares, the internet addresses it contacts, its events and the shape of its settings. Everything anyone is asked to consent to is read from it.
_Avoid_: manifest on its own, metadata

**Plugin category**:
The kind of extension point a plugin fills, such as DataGateway, notification channel, storage driver or feedback sink.
_Avoid_: plugin type; category on its own

**Feature**:
A named, user-visible part of a plugin that groups the permissions it needs. For a given consent unit it works only when every permission it groups is granted.
_Avoid_: capability, capability surface, feature flag

**Plugin registry**:
The planned index of plugins a server can install from.
_Avoid_: registry on its own

**Official registry**:
The project's own plugin registry, planned to be present on every server from the start. It is where official plugins are installed from.
_Avoid_: default registry, bundled registry

**Registry source**:
Planned: one plugin registry a server reads from. Every server has the official registry, which cannot be removed.
_Avoid_: registry on its own, source on its own

**Official plugin**:
A plugin the project's maintainers publish through the official registry, installed like any other plugin. The BoardGameGeek and IGDB DataGateways are meant to become official plugins.
_Avoid_: bundled plugin (no plugin ships inside the server), first-party, built-in

**Built-in driver**:
Code that ships inside the server and provides what a plugin could also provide, such as local disk storage or the local feedback sink. It is not a plugin.
_Avoid_: bundled plugin, built-in plugin

**Plugin artifact**:
The packaged, checksummed file one version of a plugin is distributed as; installing from one, by link or by upload, is planned.
_Avoid_: package, bundle

**Provenance**:
Where a plugin's artifact came from: its link, checksum and registry.
_Avoid_: provenance for who maintains a permission catalog entry (say managed by), the lifecycle history, or a revocation reason

**Install**:
Adding a plugin to a server, which only server admins do. A household admin can switch on, for their household, a plugin that is already installed.
_Avoid_: household install

**Install ingress**:
Planned: the way a plugin's artifact reaches a server to be installed, from a plugin registry, by link or by upload.
_Avoid_: ingress on its own (data pushed to a running plugin comes in through topics)

**Plugin scope**:
Where a plugin is switched on and configured: for the whole server, or by each household. A plugin is installed once per server whatever its scope.
_Avoid_: installation scope, enablement level; consent scope (who must consent to a permission)

**Execution mode**:
How a plugin's code is run: inside the server's own process, or, planned, in a separate process. Further modes, such as remote, are added as they ship.
_Avoid_: isolation tier, tier; isolation (the separate-process mode is not a security boundary); worker, for the separate-process mode

**Plugin context**:
The deliberately narrow set of server services a plugin is handed: logging, its own settings, emitting its declared events, and a read-only view of who triggered it. It is the only way a plugin is meant to reach the server; nothing stops a plugin importing the server's internals directly, which is why such code is a forbidden import.
_Avoid_: capability surface, DI scope

**Forbidden import**:
Code in a plugin that reaches for the server's internals or for raw network or database access, found by a scan at install. A hit blocks the install unless whoever installs it accepts that exact import on the record, since the scan is a check for honest authors, not a sandbox.
_Avoid_: sandbox, security scan

**Outbound domains**:
The internet hosts a plugin declares it will contact. A plugin may instead leave its reach to whatever the outbound HTTP policy allows, which counts as widening it.
_Avoid_: allowlist, network reach

**Plugin-owned storage**:
Planned: data a plugin keeps for itself, apart from the server's own records, in a simple key-value store by default and in tables of its own only if that proves too little.
_Avoid_: own tables, plugin tables

**Discovery contribution**:
Planned: information a plugin adds, according to its category, to what the server tells clients about itself.
_Avoid_: tier

**Plugin inventory**:
The list of plugins installed on a server as one viewer sees it: the server's view with operational detail, a household's view, or a user's own.
_Avoid_: catalog, installed list

**Plugin-emitted event**:
An event a plugin publishes under its own name. It may emit only the events its manifest declares.
_Avoid_: plugin event, lifecycle event

### Plugin consent

**Consent scope**:
Who must consent before a plugin may use a permission it requests: the server, a household, or each user. The plugin's author sets it per permission, and it defaults to the server.
_Avoid_: grant scope, scope type, axis; scope on its own

**Consent unit**:
The one server, household or user that gives or refuses consent to a plugin's permissions, and on whose behalf the plugin is acting at a given moment. A plugin's authority is always that of the unit it is acting for.
_Avoid_: unit on its own (in anything users read), operating unit, principal, scope

**Requested permission**:
A permission a plugin's manifest asks for. The plugin may use it only once the consent it needs is given.
_Avoid_: check, permission check

**Declared permission**:
A permission a plugin defines in its own namespace for its own features. It is always classed as low risk and is removed with the plugin.
_Avoid_: own-namespace permission, plugin-declared, plugin permission

**Required permission**:
A permission a plugin asks for and cannot work without: a server that refuses one blocks any update needing it, and a household or user that has not granted one is suspended. Refusing an optional permission only switches off its feature.
_Avoid_: mandatory

**Consent decision**:
An answer to a plugin's request for a permission, given for the server, a household or a user: granted or denied.
_Avoid_: grant, plugin grant (for the record itself)

**Pending decision**:
A permission a plugin requests that the deciding unit has not answered, or whose earlier grant no longer counts, for example because its risk has risen since. It confers nothing.
_Avoid_: undecided, never asked; pending for a staged update

**Durable denial**:
A consent decision that refuses a permission and stays refused until someone changes it.
_Avoid_: rejected grant, denied grant

**Stale consent**:
A grant given when the permission carried a lower risk level than it does now. It counts as pending until the unit consents again.
_Avoid_: stale risk, risk-stale grant

**Revocation**:
A consent decision undone without anyone choosing to undo it. Either whoever gave it lost the authority to, for example by leaving the household, or an update removed the permission or moved it to another consent scope. The permission goes back to awaiting an answer, and the reason is kept.
_Avoid_: invalidation; durable denial (a refusal someone chose)

**Categorical exclusion**:
The permissions no plugin may ever be granted, whatever anyone consents to, such as administering plugins or anything covering every resource type.
_Avoid_: hard exclusion

**Consent surface**:
Everything a consent unit is shown about a plugin's requested permissions: grouped by feature, marked by which are its own to decide, and showing where each stands.
_Avoid_: consent presentation, consent screen

**Critical confirmation**:
Retyping each Critical-risk permission that an install or update gives server consent to, or gives it again after its risk rose, to approve that install or update. Permissions households or users decide, and those already granted at their current risk, are not retyped.
_Avoid_: second factor, typed confirmation

**Unit enablement**:
A household's or user's own participation in a plugin: their on/off choice and their settings. A household creates it by switching the plugin on; a user's is created by their first grant.
_Avoid_: enablement row, anchor, enrolled, unit row

**Late acceptance**:
A consent that answers a unit's last outstanding required permission and so lifts its suspension.
_Avoid_: re-enable (that is the unit's own switch), late consent

**Re-consent**:
A fresh answer a unit owes because an update made a permission newly required for it, raised its risk, or moved it to the unit's consent scope.
_Avoid_: reconsent, re-prompt

**Pre-consent**:
Consent given ahead of an update, which takes effect when the update lands.
_Avoid_: dormant grant

### Plugin lifecycle and updates

**Server switch**:
The on/off control for a plugin across the whole server. Nothing runs for anyone while it is off, and each unit's own switch sits beneath it.
_Avoid_: kill switch, server-level switch; enabled on its own

**Suspension**:
A plugin unit stopped because consent it needs is missing. It resumes once the consent is given.
_Avoid_: disabled, auto-disabled

**Dormancy**:
A plugin unit, for the server or a household, kept in place but unable to run until something is fixed, such as settings a new version no longer accepts. Nobody chooses it; switching a plugin off on purpose is disabling it.
_Avoid_: dormant for consent given ahead of an update (say pre-consent)

**Restart required**:
A change the server has recorded but will act on only after its next restart, such as a new active version, a plugin switched on while not loaded, or an uninstall.
_Avoid_: pending restart, hot reload

**Uninstalled plugin**:
What remains when a plugin is uninstalled: every consent is discarded so a reinstall starts afresh, while unit settings are kept, unless purged, so a reinstall restores them.
_Avoid_: tombstone, deleted, removed

**Lifecycle event**:
A permanent record of one change in a plugin's life, such as its install, a consent decided, a unit suspended, or its uninstall. It is kept after uninstall and never cleaned away.
_Avoid_: plugin event, audit entry, provenance timeline

**Channel floor**:
Planned: the least stable release channel a server will be offered plugin updates from, set for the whole server and overridable per registry and per plugin.
_Avoid_: floor on its own, minimum channel

**Update check**:
Planned: a server's periodic, opt-in question to a plugin's author about whether a newer version exists. It is off by default, so a self-hosted server contacts nobody without being told to.
_Avoid_: update polling, phone home; check on its own

**Plugin update**:
Replacing a plugin's active version with a newer one. A server runs one version of a plugin for everyone, never different versions for different units.
_Avoid_: per-unit version, version pinning

**Staged update**:
A plugin's new version, checked and waiting for approval before it goes live.
_Avoid_: pending update (pending means a consent awaiting an answer)

**Escalation**:
A change in a new plugin version that widens what the plugin can reach or changes who must consent, such as a new or newly required permission, a risk that rose, a permission moved to another consent scope, a new outside host, or new write access to the server's data. Translations and new features are not escalations.
_Avoid_: breaking change, permission escalation

**Server-gating escalation**:
An escalation the server must approve before an update can go live. Escalations that households or users own never wait for the server; those units are suspended instead.
_Avoid_: blocking escalation

**Update approval**:
The server's consent to a staged update, which activates it; rejecting it discards the staged update instead.
_Avoid_: accept, grant; reject (for a refused permission)

**Activation**:
A staged update becoming the plugin's version on record. The running code switches at the next restart.
_Avoid_: activation for a feature working (say feature state) or for plugin-owned tables (say enabling them)

**Plugin rollback**:
Planned: returning a plugin to an earlier version, for the whole server and never for one unit.
_Avoid_: rollback on its own, per-household downgrade
