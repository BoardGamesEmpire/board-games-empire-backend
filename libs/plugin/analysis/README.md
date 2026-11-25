# plugin-analysis

The checks the server runs over a plugin's code, without Nest, a database or a
network, so a plugin author's tools can run the server's own code (#1093).

It holds two checks today. The static import scan: `PluginStaticAnalyzer` reads
a plugin's files (never runs them) and reports forbidden imports, dependencies
the scan cannot screen, and files it could not read or parse. And the hardened
plugin artifact extractor: `extractPluginArchive` unpacks a plugin artifact
into a new directory, holding every entry to the archive rules in
`@boardgamesempire/plugin-manifest`, and removes what it wrote when it refuses
one (#1094, #1166). `quoteUntrustedText` quotes and cuts text from an
untrusted source, such as an entry name, before it goes into a message.

The analyzer refuses to run on a parser build that fails its capability probes
(`PluginStaticAnalysisUnavailableError`), because a scan at partial coverage
must never read as a complete one (#219).

## Building

Run `npm run nx -- build plugin-analysis` to build the library.

## Running unit tests

Run `npm run nx -- test plugin-analysis` to execute the unit tests via [Jest](https://jestjs.io).
