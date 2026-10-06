# syntax=docker/dockerfile:1

# One image for every BGE role, and one image for each game gateway (#593).
# Build from the repository root:
#
#   docker build -t bge .
#   docker build --target boardgamegeek-gateway -t bge-boardgamegeek-gateway .
#   docker build --target igdb-gateway -t bge-igdb-gateway .
#
# The BGE image runs one role per container, chosen by BGE_ROLES. How to run
# it, and what each role needs, is in docs/DEPLOYMENT.md. It also carries the
# web client's build, which the api serves (#598).
#
# Building needs network access: to the npm registry, to binaries.prisma.sh for
# Prisma's schema engine (or a PRISMA_ENGINES_MIRROR), to buf.build for the
# gateway protos' dependencies, and to ghcr.io for the web client's image.
#
# Every stage works in /app, the directory the images run from. The images keep
# the workspace's layout, so a bundle runs exactly as it does from a checkout,
# and a path that a build writes into a bundle names the same place at runtime.

# The web client's build (#598): an image that holds only its static files, at
# /web, published from the client repository. Renovate moves the digest when
# the client's `edge` moves (#599). The BGE image records this reference as a
# label, so it names the client it carries.
ARG CLIENT_WEB_IMAGE=ghcr.io/boardgamesempire/bge-client-web:edge@sha256:c17de82a6d3283ca6c0136479ae1add921cfecf348390fd7d2a690aa57e8a8f4
# The client's image is a single linux/amd64 manifest, and its files are the
# same on every platform, so every build takes that one. Naming the platform
# keeps BuildKit from warning that an arm64 build pulled an amd64 image; it is
# an argument because BuildKit also warns about a constant platform.
ARG CLIENT_WEB_PLATFORM=linux/amd64

# Node 24, the major CI runs (.github/actions/setup-workspace). Renovate moves
# the digest (#599); a new major changes CI and this line together.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS node

# Every workspace's package.json at its own path, with the lockfile. Both
# installs need all of them, and copying nothing else into their stages keeps
# the installs cached until a manifest changes.
FROM scratch AS manifests
COPY --parents package.json package-lock.json .npmrc apps/**/package.json libs/**/package.json /

# The production dependencies of every workspace, from the root lockfile, in
# the workspace's layout (#593): one install that all the images share. Its
# install scripts run, so Prisma's schema engine is fetched here, into a cache
# the build stage's install shares.
FROM node AS deps
WORKDIR /app
COPY --from=manifests / ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.cache/prisma \
    npm ci --omit=dev --no-audit --no-fund

# The full install, and the builds. The protos are exported first because the
# app builds copy them, and nothing in the task graph exports them (#313).
# `.env` comes from `.env.example`, as in CI.
FROM node AS build
WORKDIR /app
ENV NX_DAEMON=false \
    NX_NO_CLOUD=true
COPY --from=manifests / ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.cache/prisma \
    npm ci --no-audit --no-fund
COPY . .
RUN cp .env.example .env \
 && npx nx run @boardgamesempire/proto-gateway:buf-export \
 && npx nx run-many -t build --skipSync -p \
      @boardgamesempire/launcher \
      @boardgamesempire/api \
      @boardgamesempire/worker \
      @boardgamesempire/gateway-worker \
      @boardgamesempire/gateway-coordinator \
      @boardgamesempire/boardgamegeek-gateway \
      @boardgamesempire/igdb-gateway

# What every image runs on: the production install and the four workspace
# packages the bundles load at runtime instead of bundling. Prisma's telemetry
# stays off, as `.env.example` has it: the api runs the Prisma CLI to migrate.
FROM node AS runtime
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=deps /app ./
COPY --from=build /app/libs/plugin/contract/dist libs/plugin/contract/dist
COPY --from=build /app/libs/plugin/manifest/dist libs/plugin/manifest/dist
COPY --from=build /app/libs/proto/gateway/dist libs/proto/gateway/dist
COPY --from=build /app/libs/storage/contract/dist libs/storage/contract/dist

FROM runtime AS boardgamegeek-gateway
COPY --from=build /app/apps/boardgamegeek-gateway/dist apps/boardgamegeek-gateway/dist
RUN --mount=type=bind,source=libs/scripts/src,target=/tmp/bge-scripts \
    node /tmp/bge-scripts/bin/check-bundle-externals.js apps/boardgamegeek-gateway/dist/main.js
ARG REVISION
ARG VERSION
ARG CREATED
LABEL org.opencontainers.image.source="https://github.com/BoardGamesEmpire/board-games-empire-backend" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${CREATED}"
USER node
CMD ["node", "apps/boardgamegeek-gateway/dist/main.js"]

FROM runtime AS igdb-gateway
COPY --from=build /app/apps/igdb-gateway/dist apps/igdb-gateway/dist
RUN --mount=type=bind,source=libs/scripts/src,target=/tmp/bge-scripts \
    node /tmp/bge-scripts/bin/check-bundle-externals.js apps/igdb-gateway/dist/main.js
ARG REVISION
ARG VERSION
ARG CREATED
LABEL org.opencontainers.image.source="https://github.com/BoardGamesEmpire/board-games-empire-backend" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${CREATED}"
USER node
CMD ["node", "apps/igdb-gateway/dist/main.js"]

# The web client's files, for the BGE image only: the gateways don't serve it.
FROM --platform=${CLIENT_WEB_PLATFORM} ${CLIENT_WEB_IMAGE} AS client-web

# The BGE image, and the default target. The launcher reads BGE_ROLES and runs
# that role's bundle in its own process, so the role's signal handlers are the
# process's. The media and plugin roots are created for the image's user, so a
# volume mounted on either starts out writable by it; storage refuses to boot
# without its root, rather than writing to a directory nobody provisioned.
# The web client goes beside the api's bundle, where the api looks for it.
FROM runtime AS bge
COPY --from=build /app/apps/launcher/dist apps/launcher/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=client-web /web apps/api/dist/web
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/gateway-worker/dist apps/gateway-worker/dist
COPY --from=build /app/apps/gateway-coordinator/dist apps/gateway-coordinator/dist
RUN --mount=type=bind,source=libs/scripts/src,target=/tmp/bge-scripts \
    node /tmp/bge-scripts/bin/check-bundle-externals.js \
      apps/api/dist/main.js \
      apps/worker/dist/main.js \
      apps/gateway-worker/dist/main.js \
      apps/gateway-coordinator/dist/main.js \
 && mkdir -p /var/lib/bge/media /var/lib/bge/plugins \
 && chown node:node /var/lib/bge/media /var/lib/bge/plugins
ARG REVISION
ARG VERSION
ARG CREATED
ARG CLIENT_WEB_IMAGE
LABEL org.opencontainers.image.source="https://github.com/BoardGamesEmpire/board-games-empire-backend" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${CREATED}" \
      io.github.boardgamesempire.web.image="${CLIENT_WEB_IMAGE}"
USER node
CMD ["node", "apps/launcher/dist/main.js"]
