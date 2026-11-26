# Games are played, products are owned

A **Game** is something a group picks when deciding what to play, with rules-level facts of its own: a board game, an expansion, a video game, an RPG line such as D&D 5th Edition, Magic, Hearts. Everything else a user can own is a **Product**: an RPG book or adventure, an accessory, terrain, a hand-made dice tower, and later a card printing, sealed product or deck. A product links to the games it belongs to, and each link's role (**Plays**, **Adds**, **Supports** or **Component**) decides what owning the product lets someone do. Only a product that Plays a game can supply that game to an event's lineup.

The catalog assumed that a board game box is both the thing you own and the thing you play. The glossary said so ("Expansions, accessories and bundles are games too"). That held for board games and video games, strained for RPGs (you own the books but play the line) and broke for trading card games (you own printings and build decks but play Magic). It also let plays, nominations and votes accept a dice tower. The decision was made in a design brainstorm on 2026-11-26, revised after a builder check and an external review the same day, and is tracked in #1565.

- **The Game test decides, not ratings or shape.** Expansions stay games: they change the rules, the player count and the play time, plays record them, and they keep their own ratings. Products are rated too, so a rating no longer argues for being a game.
- **A link's role carries the meaning, not a flag on the product.** A starter set Plays the DCC RPG, an adventure Adds to D&D 5e, a dice tower Supports a game or nothing, and a card printing is a Component of Magic. A standard 52-card deck is one product that Plays the traditional card games, with each brand a version of it.
- **Ownership is shared.** A collection entry names a platform game or a product, never both, and keeps the copies, loans, locations and event offers it already has (#1231). Product versions (a printing, the PDF) are what a copy names, as a game copy names a release.
- **A game type says what a game is; a platform says where it's played.** Every game carries one of board game, video game, tabletop RPG, trading card game or traditional card game. A virtual tabletop such as Board Game Arena is a platform type, not a game type.
- **Search keeps RPG and trading-card content out until asked, and the server decides that, not the drivers.** The API turns a request into explicit `game_types` and `excluded_game_types` lists before it asks the local catalog or any DataGateway. An empty list never means "the default". Games and products are searched separately, with one request shape and one envelope, so the two searches can merge later.
- **The move is gradual.** Products start with the things that are not game editions. Board and video game editions keep `PlatformGame` and `GameRelease` until moving them onto products proves worth its cost (#1583). The product table is shaped so that move extends it rather than replacing it.

## Considered options

- **Accessories and RPG books as Game rows**, told apart by content type. It needs no new model, but plays, nominations and votes would accept a dice tower, and card games would multiply the content types. Rejected.
- **One collection-entry table with a nullable link per kind** (game, item, card). It's cheap, but card-scale rows and card-only columns would land in the games table, and each kind would grow its own rules for what it can do. Rejected.
- **A product-centric catalog in one step**: every ownable thing a product and Game only the playable title, with `PlatformGame`, `GameRelease` and the DLC tables folded in at once. It's the most uniform, and the direction chosen, but in one step it would change the catalog, import, events, plays, lists, permissions, every DataGateway driver and the client together. Rejected as a single step; kept as the end state.
- **RPG values in `ContentType`**: the cheapest way to find RPG content. Content type is shape, not kind of game, so it can't tell an RPG line from a board game or an RPG dice set from card sleeves without a copy of every shape for every kind. Rejected.
- **Search options specific to one DataGateway**, such as BGG's `subtype=rpgitem` behind a BGG-only route. It answers the first symptom and nothing else, and every DataGateway would grow its own. Rejected for a game-type axis every DataGateway declares.

## Consequences

- A new kind of ownable thing is a new `ProductKind`, and what it can do follows from its links. Plays, nominations and votes never need to learn about it.
- `ContentType.Accessory` goes away. BGG accessories import as products that Support their base game, and the add-on link between games no longer covers accessories (#660).
- Every read that assumed a collection entry has a game now decides whether it reads games only (household game pools, play stats) or everything owned (collections, loans, locations, offers).
- A private product offered at an event or lent shows a fixed summary to the attendees or the borrower while the offer or loan stands. Being offered or lent never makes it findable.
- The first search filter whose default narrows is resolved in one place, the API, so changing the default, or letting users save their own (#1242), changes nothing in any driver.
- A DataGateway that sends products implements three more operations, each covered by the contract suite before any driver declares it.
