# web-client

Serves the bundled web client's build from the api's own HTTP server (#598).

The api mounts it in `apps/api/src/main.ts`, with the build directory beside its bundle (`apps/api/dist/web`, which the `Dockerfile` fills). If that directory has no `index.html`, `createWebClient` returns `undefined`, and the api serves only the API. The operator's view is in `docs/DEPLOYMENT.md`, under "The web client".

`createWebClient` is mounted before Nest registers its routes, so its caller passes in the server's own routes, and the middleware never answers under them.

## Running unit tests

Run `nx test @board-games-empire/web-client` to execute the unit tests via [Jest](https://jestjs.io).
