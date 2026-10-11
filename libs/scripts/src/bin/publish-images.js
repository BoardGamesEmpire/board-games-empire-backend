#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for publish in ci.yml (#600): tags the images the image smoke
 * suite tested, and moves `edge` if it should. Pass the platforms the smoke ran
 * on, then the images, the BGE image first:
 *
 *   node publish-images.js --platform linux/amd64 --platform linux/arm64 \
 *     ghcr.io/boardgamesempire/bge ghcr.io/boardgamesempire/bge-boardgamegeek-gateway ...
 *
 * It reads TESTED, build-push's outputs: the digests each image smoke job pulled
 * and tested, which publish needs to have passed. It also reads GITHUB_SHA,
 * GITHUB_REF, GITHUB_REPOSITORY, GITHUB_API_URL and GITHUB_TOKEN, and needs
 * `docker login` to the registry first. The job's concurrency group runs one
 * publish at a time, so no other run writes a tag between this one's reads and
 * its writes.
 *
 * Every image's `sha-<short>` is read and checked before the first is written,
 * so a run that fails a check writes nothing. Then it writes them. Only after
 * that does it read `edge` and ask GitHub where this commit stands: no rule
 * reads another commit's tags, so a GitHub outage then costs only the `edge`
 * move, which a re-run makes, and never the `sha-<short>` a release promotes.
 * If `edge` moves, it moves each image's. The first image's `edge` decides for
 * all, and it moves first: after a failed write, a gateway's `edge` can lag
 * behind it until a re-run, but never get ahead of it, where an older commit's
 * run could move it back.
 *
 * The log records each tag as it is written, so a run that fails partway says
 * what it changed. The step summary records what was published, and which
 * tested digests each index lists. Deliberately thin: the rules are in
 * `image-tags/rules.js`.
 */
const { parseArgs } = require('node:util');

const { branchTip, compare } = require('../image-tags/github');
const { planIndex, readDigest, readIndex, readLabels, readTag, writeTag } = require('../image-tags/registry');
const { edgeDecision, publishProblems, shaTag, testedDigests } = require('../image-tags/rules');
const { annotate, appendSummary, requiredEnv } = require('../image-tags/workflow');

const WEB_IMAGE_LABEL = 'io.github.boardgamesempire.web.image';

const packageName = (image) => image.slice(image.lastIndexOf('/') + 1);

/**
 * What to do with one image's `sha-<short>`, checked before anything is
 * written. One that exists names this commit, or build-push would have stopped,
 * and it stays as it is if it lists exactly the tested images. Otherwise the
 * index of the tested images is planned and checked here, and written later.
 */
function checkShaTag({ image, tag, commit, tested }) {
  const published = readTag(image, tag);
  if (published !== null) {
    const problems = publishProblems({ commit, manifest: published.manifest, tested, labels: published.labels });
    if (problems.length > 0) throw new Error(`${published.ref} can't stand as this commit's: ${problems.join('; ')}.`);

    console.log(`${published.ref} already lists exactly the tested images, so it stays as it is.`);
    return { image, tested, labels: published.labels, digest: published.digest, sources: null };
  }

  const digests = Object.values(tested);
  const sources = digests.map((digest) => `${image}@${digest}`);
  const labels = Object.fromEntries(digests.map((digest) => [digest, readLabels(`${image}@${digest}`)]));
  const problems = publishProblems({ commit, manifest: planIndex(sources), tested, labels });
  if (problems.length > 0) {
    throw new Error(`an index of ${image}'s tested images can't be published: ${problems.join('; ')}.`);
  }

  console.log(`An index of ${image}'s tested images lists exactly them, and becomes ${image}:${tag}.`);
  return { image, tested, labels, digest: null, sources };
}

/**
 * Writes a planned `sha-<short>`, and checks what the registry then serves under
 * it. The labels checked before the write still hold: they belong to the tested
 * digests, which the check finds listed, or names as a problem.
 */
function writeShaTag({ plan, tag, commit }) {
  if (plan.sources === null) return { ...plan, written: false };

  writeTag(`${plan.image}:${tag}`, plan.sources);
  const written = readIndex(plan.image, tag);
  const problems =
    written === null
      ? ["it can't be read back"]
      : publishProblems({ commit, manifest: written.manifest, tested: plan.tested, labels: plan.labels });
  if (problems.length > 0) throw new Error(`${plan.image}:${tag} was written, but ${problems.join('; ')}.`);

  console.log(`Wrote ${plan.image}:${tag} as ${written.digest}.`);
  return { ...plan, digest: written.digest, written: true };
}

/** Points an image's `edge` at its `sha-<short>`'s index, unless it already does, and checks the registry agrees. */
function moveEdge({ published, was }) {
  if (was !== published.digest) {
    writeTag(`${published.image}:edge`, [`${published.image}@${published.digest}`]);

    const now = readDigest(published.image, 'edge');
    if (now !== published.digest) throw new Error(`${published.image}:edge points at ${now}, not ${published.digest}.`);
    console.log(`Moved ${published.image}:edge to ${published.digest}, from ${was ?? 'nothing'}.`);
  }

  return { image: published.image, digest: published.digest, was };
}

function shaSummary({ commit, tag, platforms, published }) {
  const cells = (values) => `| ${values.join(' | ')} |`;
  const rows = published.map(({ image, digest, written, tested }) =>
    cells([
      `\`${image}\``,
      `\`${digest}\` (${written ? 'written' : 'already there'})`,
      ...platforms.map((platform) => `\`${tested[platform]}\``),
    ]),
  );
  const [bge] = published;
  const web = bge.labels[bge.tested[platforms[0]]]?.[WEB_IMAGE_LABEL];

  return [
    `## Images tagged \`${tag}\`, from \`${commit}\``,
    '',
    cells(['Image', `\`${tag}\``, ...platforms.map((platform) => `${platform}, tested`)]),
    cells(['---', '---', ...platforms.map(() => '---')]),
    ...rows,
    '',
    'Each index lists exactly the digests the image smoke suite tested, each under its own platform, and each image names this commit.' +
      (web ? ` The BGE image carries the web client \`${web}\`.` : ''),
    '',
    '',
  ].join('\n');
}

/** What happened to `edge`, as the summary and the annotation put it. */
function edgeOutcome({ decision, moved }) {
  if (!decision.move) return 'stays where it is';

  return moved.some((edge) => edge.was !== edge.digest) ? 'moved' : "didn't need to move";
}

function edgeSummary({ decision, moved }) {
  const headline = `\`edge\` ${edgeOutcome({ decision, moved })}: ${decision.reason}`;
  if (!decision.move) return `${headline}\n`;

  const was = ({ digest, was: before }) => {
    if (before === null) return 'none';
    return before === digest ? 'unchanged' : `\`${before}\``;
  };

  return [
    headline,
    '',
    '| Image | `edge` | Was |',
    '| --- | --- | --- |',
    ...moved.map((edge) => `| \`${edge.image}\` | \`${edge.digest}\` | ${was(edge)} |`),
    '',
  ].join('\n');
}

async function main() {
  const { values, positionals: images } = parseArgs({
    options: { platform: { type: 'string', multiple: true } },
    allowPositionals: true,
  });
  const platforms = values.platform ?? [];
  if (platforms.length === 0 || images.length === 0) {
    throw new Error('name the platforms and the images, the BGE image first: --platform linux/amd64 <image>...');
  }

  const commit = requiredEnv('GITHUB_SHA');
  const branch = requiredEnv('GITHUB_REF').replace(/^refs\/heads\//, '');
  const github = {
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    repository: requiredEnv('GITHUB_REPOSITORY'),
    token: process.env.GITHUB_TOKEN,
  };
  const tag = shaTag(commit);
  const tested = testedDigests(JSON.parse(requiredEnv('TESTED')), { images: images.map(packageName), platforms });

  // Every sha-<short>, checked, then written.
  const plans = images.map((image) => checkShaTag({ image, tag, commit, tested: tested[packageName(image)] }));
  const published = plans.map((plan) => writeShaTag({ plan, tag, commit }));
  appendSummary(shaSummary({ commit, tag, platforms, published }));

  // Then edge: read, decided, and moved if it should.
  const [bge, ...others] = images;
  const edge = readTag(bge, 'edge');
  const otherEdges = others.map((image) => readDigest(image, 'edge'));
  const decision = await edgeDecision({
    commit,
    tip: await branchTip(github, branch),
    edge,
    otherEdges,
    compare: (base, head) => compare(github, base, head),
  });

  const edges = [edge?.digest ?? null, ...otherEdges];
  const moved = decision.move ? published.map((image, i) => moveEdge({ published: image, was: edges[i] })) : [];
  annotate(
    decision.warning ? 'warning' : 'notice',
    `edge ${edgeOutcome({ decision, moved })}: ${decision.reason.replace(/`/g, '')}`,
  );
  appendSummary(edgeSummary({ decision, moved }));
}

main().catch((error) => {
  annotate('error', error.message);
  process.exitCode = 1;
});
