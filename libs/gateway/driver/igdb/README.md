# gateway-driver-igdb

IGDB's DataGateway driver as a library (#1082). The IGDB gateway app hosts it
as a remote DataGateway, and a plugin DataGateway will load the same code
(#1084).

It has no Nest dependency, imports none of the server's own packages, and
reaches IGDB and Twitch only through the `UpstreamFetch` it is handed.
`src/lib/plugin-safety.spec.ts` holds it to that.

Its client writes IGDB's queries as apicalypse 1.x did, so IGDB is asked
exactly what it was asked before. It replaced `igdb-api-node`, whose
`apicalypse` sent requests through `axios`, which plugin static analysis
rejects. The token endpoint stays a parameter, so the gateway app keeps
`IGDB_TOKEN_URL`.

## Parity and recording

`igdb.parity.spec.ts` holds the driver to golden outputs recorded from the
IGDB gateway app before its code moved here, over the upstream fixtures in
`src/testing/fixtures`. A fixture is named by its endpoint and a hash of its
query's clauses (`igdbFixtureKey`); each query sits beside its answer in a
`.apicalypse` file.

- To record the goldens again from the driver, run the parity spec with
  `BGE_RECORD_GOLDEN=true`, then review the diff.
- To record IGDB's answers again too, add `BGE_RECORD_UPSTREAM=true`,
  `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET`, and record the goldens in the
  same run. IGDB answers a query with no sort, such as fetchExpansions', in
  no fixed order, so new answers can reorder a golden. The driver asks IGDB
  itself, through `createRecordingFetch`; the token's answer is never kept.
  #614's stubbed upstreams can reuse the fixtures.

## Running unit tests

Run `npm run nx -- test gateway-driver-igdb`.
