# Image smoke suite

Tests the images, not a checkout (#600). It runs the BGE image and both game gateway images as `compose.yaml`'s split profile, and drives them from outside, as a self-hoster's clients do:

- a first boot on an empty database, with every role up;
- both gateway images healthy, without real credentials;
- a sign-up and a sign-in;
- a search and an import through a stub gateway (`apps/stub-gateway`), over HTTP and Socket.IO;
- the bundled web client in headless Chromium;
- a shutdown in which every role and gateway exits 0, with no error logged on the way.

CI runs it on every pull request and on `master`, once per platform, against images it has just built (`.github/workflows/ci.yml`, the `image-smoke` job).

## Running it

From the repository root, build the images, install Chromium once, then run the `smoke` target:

```sh
docker compose --profile split build
npx playwright install --only-shell chromium
npx nx run @boardgamesempire/image-smoke:smoke
```

`BGE_IMAGE`, `BGE_BOARDGAMEGEEK_GATEWAY_IMAGE` and `BGE_IGDB_GATEWAY_IMAGE` name other images to test, as they do for Compose. The suite builds the stub gateway's image itself, on top of the BGE image it is testing (`apps/stub-gateway/Dockerfile`).

The stack runs as the Compose project `bge-image-smoke`, with a database of its own and secrets generated for the run. Apart from the images above, nothing in your shell or your `.env` reaches it: the variables `compose.yaml` reads come from the run's settings alone. It publishes the api on a free loopback port, so it runs beside a stack of your own. Each run starts from an empty database.

To run it twice at once, from two worktrees, say, name another project for one of the runs in `BGE_SMOKE_PROJECT`. The project names everything a run leaves: its containers and volumes, the stub gateway's image, and its files.

## When it fails

- Each container's output is in `apps/image-smoke/test-output/<project>/logs/`, with the run's settings beside it in `stack.env`. CI prints the logs.
- `BGE_SMOKE_KEEP=true` leaves the stack running at the end, skipping the shutdown steps that would stop it, and prints the command that removes it.
- The suite's own helpers have unit tests, which run with every other project's `test`. The suite has its own Jest config, `jest.smoke.config.cts`, so no `test` target runs it, and its target is named `smoke`, not `e2e`: the CI e2e job runs every affected `e2e` target, with no images.
