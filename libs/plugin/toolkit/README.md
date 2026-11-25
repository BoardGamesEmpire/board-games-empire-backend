# plugin-toolkit

`bge-plugin`, the plugin author CLI: the command a plugin author runs to check
a plugin and build its plugin artifact, using the server's own checks (#1093).
It reaches the server's verdicts by running the server's own code from
`@boardgamesempire/plugin-manifest` and `@boardgamesempire/plugin-analysis`,
never a second copy of a check.

Run `bge-plugin --help` for the commands and options.

## Building

Run `npm run nx -- build plugin-toolkit` to build the library and its bin. The
build stamps the workspace version into the CLI as the default
`--bge-version`.

## Running unit tests

Run `npm run nx -- test plugin-toolkit` to execute the unit tests via [Jest](https://jestjs.io).
