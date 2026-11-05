# gateway-driver-boardgamegeek

BoardGameGeek's DataGateway driver as a library (#1082). The BoardGameGeek
gateway app hosts it as a remote DataGateway, and a plugin DataGateway will
load the same code (#1084).

It has no Nest dependency, imports none of the server's own packages, and
reaches BGG only through the `UpstreamFetch` it is handed.
`src/lib/plugin-safety.spec.ts` holds it to that.

Its client parses BGG's XML itself and keeps BGG's text as BGG sent it, so a
name like "007" stays "007" (#863). It replaced `bgg-ts-client`, which fetched
through `isomorphic-unfetch` and turned text that looked like a number into
one.

## Parity and recording

`boardgamegeek.parity.spec.ts` holds the driver to golden outputs recorded
from the BoardGameGeek gateway app before its code moved here, over the
upstream fixtures in `src/testing/fixtures`. A fixture is named by the request
it answers (`bggFixtureKey`), so any client that asks the same thing finds it.

- To record the goldens again from the driver, run the parity spec with
  `BGE_RECORD_GOLDEN=true`, then review the diff.
- To record BGG's answers again too, add `BGE_RECORD_UPSTREAM=true` and
  `BOARDGAMEGEEK_API_KEY`. The driver then asks BGG itself, through
  `createRecordingFetch`, which keeps each answer as its fixture. #614's
  stubbed upstreams can reuse the fixtures.

## Running unit tests

Run `npm run nx -- test gateway-driver-boardgamegeek`.
