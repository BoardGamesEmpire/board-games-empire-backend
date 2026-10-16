# @bge/version

The product version, stamped into the build: the root `package.json`'s `version`, exported as `BGE_VERSION`.

- The api checks plugin manifests' `bgeCompat` ranges against it (#212).
- The BoardGameGeek, IGDB and stub DataGateways report it on Ping. The server re-interviews a DataGateway when the version it reports changes (#712).

It reads `0.0.0` until server releases bump the root version (#601). It isn't the `BGE_VERSION` environment variable, which an operator sets and `DeploymentInfoService` reports.

## How it's made

This project's `generate` target runs `libs/scripts/src/bin/generate-bge-version.js`, which writes `src/lib/generated/bge-version.ts`. The file is gitignored. Nx runs `generate` before a typecheck, test or build of any project that imports this library. The script refuses a version that isn't valid semver, so a bad version fails the build.

Each app bundles the constant, so an app always reports the version it was built at.

A cached build can keep the previous version after the root version changes. The generated file is gitignored, so it isn't among the inputs of the builds that bundle it (#311). The image build starts without a cache, so images always carry the right version. Locally, build with `--skip-nx-cache` after changing the version.
