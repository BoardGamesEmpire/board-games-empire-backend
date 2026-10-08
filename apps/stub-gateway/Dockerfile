# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom

# The stub gateway on a BGE image, for the image smoke suite (#600). It starts
# from the image under test and adds only the stub's bundle, so the stub runs
# on that image's production install, as a real gateway would. Build it from
# the repository root once the stub is built (its `build` target):
#
#   docker build -f apps/stub-gateway/Dockerfile --build-arg BGE_IMAGE=<image> -t <tag> .
#
# The image smoke suite does this itself. BGE_IMAGE has no default, which is
# what the check skipped above warns about: the stub is only ever built on an
# image someone chose to test, and a default would also be an image for
# Renovate to look up that no registry has.
ARG BGE_IMAGE
FROM ${BGE_IMAGE}
COPY apps/stub-gateway/dist apps/stub-gateway/dist
# The check the real images run on their bundles: every package the stub
# requires must resolve from the image's production install.
RUN --mount=type=bind,source=libs/scripts/src,target=/tmp/bge-scripts \
    node /tmp/bge-scripts/bin/check-bundle-externals.js apps/stub-gateway/dist/main.js
CMD ["node", "apps/stub-gateway/dist/main.js"]
