# plugin-analysis

The checks the server runs over a plugin's code, without Nest, a database or a
network, so a plugin author's tools can run the server's own code (#1093).

Today that is the static import scan: `PluginStaticAnalyzer` reads a plugin's
files (never runs them) and reports forbidden imports, dependencies the scan
cannot screen, and files it could not read or parse.

The analyzer refuses to run on a parser build that fails its capability probes
(`PluginStaticAnalysisUnavailableError`), because a scan at partial coverage
must never read as a complete one (#219).

## Building

Run `nx build plugin-analysis` to build the library.

## Running unit tests

Run `nx test plugin-analysis` to execute the unit tests via [Jest](https://jestjs.io).
