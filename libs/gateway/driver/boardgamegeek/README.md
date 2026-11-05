# gateway-driver-boardgamegeek

BoardGameGeek's DataGateway driver as a library (#1082). The BoardGameGeek
gateway app hosts it as a remote DataGateway, and a plugin DataGateway will
load the same code (#1084).

It has no Nest dependency, imports none of the server's own packages, and
reaches BGG only through the `UpstreamFetch` it is handed.
`src/lib/plugin-safety.spec.ts` holds it to that.

## Running unit tests

Run `npm run nx -- test gateway-driver-boardgamegeek`.
