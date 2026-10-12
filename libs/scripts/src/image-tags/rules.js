'use strict';
/**
 * The rules the image jobs in ci.yml publish by (#600), kept apart from the
 * registry and GitHub calls so that tests can drive them. The entry points in
 * `src/bin` make those calls: `find-published-images.js` for build-push, and
 * `publish-images.js` for publish.
 *
 * Each package is an index of one image per platform. build-push pushes each
 * platform's image by digest, untagged, before anything tests it. The smoke
 * suite then tests those digests, and only then does publish point tags at an
 * index of them:
 *
 *   - `sha-<short>` names one commit and never moves. Every commit that passes
 *     gets one, which is what a release promotes (#601).
 *   - `edge` follows master: it moves forward to each commit published, and
 *     never back. The BGE image's `edge` decides for all three packages, and
 *     moves first.
 *
 * The writes aren't atomic. A publish that fails partway leaves the tags it
 * hadn't written yet as they were: `edge` can then trail a commit that has its
 * `sha-<short>`, and a gateway's `edge` can trail the BGE image's, until that
 * publish is re-run or a newer commit publishes.
 *
 * A run can be repeated at any point, and every rule here holds for a repeat:
 * a `sha-<short>` that names this commit is tested and tagged again rather than
 * built again, and the commit `edge` already names may move it again.
 */

const REVISION_LABEL = 'org.opencontainers.image.revision';
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * @typedef {object} Published  what a tag holds, read from the registry
 * @property {string} ref  the tag, as `<image>:<tag>`
 * @property {string} digest  the tag's own digest: an index's, or a single image's
 * @property {object} manifest  the index or image manifest, as the registry serves it
 * @property {Record<string, Record<string, string>>} labels  each image's labels, by digest:
 *   every image an index lists, or the single image itself
 */

/**
 * The images an index lists, as `{ platform, digest }`, or null for a single
 * image. A platform is `<os>/<architecture>`: the variant is left out, because
 * these images are built for amd64 and arm64 only, and Docker takes arm64's
 * default variant, `v8`, to be plain arm64. An index may list an entry with no
 * platform, such as a nested index, and that entry's platform is 'no platform'.
 */
function listedImages(manifest) {
  if (!Array.isArray(manifest.manifests)) return null;

  return manifest.manifests.map(({ digest, platform }) => ({
    digest,
    platform: platform ? `${platform.os}/${platform.architecture}` : 'no platform',
  }));
}

/**
 * What build-push does about one image on one platform, given what this
 * commit's `sha-<short>` holds. A `sha-<short>` is written only after its
 * images passed every gate, so one naming this commit is an earlier attempt's,
 * and this run tests that platform's image again rather than build another:
 * publish then leaves the tag as it is. One that names any other commit, a
 * short-SHA collision or a hand-pushed tag, stops the job.
 *
 * @param {{ commit: string, platform: string, published: Published | null }} facts
 *   `published` is null when the tag doesn't exist
 * @returns {{ action: 'build' } | { action: 'reuse', digest: string } | { action: 'stop', reason: string }}
 */
function reuseDecision({ commit, platform, published }) {
  if (published === null) return { action: 'build' };

  const stop = (problem) => ({ action: 'stop', reason: `${published.ref} ${problem}, and a sha tag never moves.` });

  const listed = listedImages(published.manifest);
  if (listed === null) return stop('is a single image, not an index');

  const [image] = listed.filter((candidate) => candidate.platform === platform);
  if (image === undefined) return stop(`lists no ${platform} image`);

  const revision = published.labels[image.digest][REVISION_LABEL];
  if (revision !== commit) return stop(`names ${revision || 'no commit'}, not ${commit}`);

  return { action: 'reuse', digest: image.digest };
}

/**
 * Whether `edge` moves to this commit. It moves when both hold:
 *
 *   - The commit is on master: master's tip is the commit, or descends from it.
 *   - The commit descends from the commit `edge` names, or is that commit.
 *     With no `edge` on any package, it must be master's tip itself: that is
 *     the first publish, or every `edge` was removed, and nothing then says
 *     which commits were published. Master's ruleset keeps master from moving
 *     back, so its tip descends from every one of them.
 *
 * Anything else leaves `edge` where it is, such as a re-run or a late run of an
 * older commit, so `edge` never moves back.
 *
 * The commit `edge` already names passes, so a re-run of it moves `edge` again.
 * That moves nothing for a package whose `edge` already names it, and brings up
 * one whose `edge` an earlier attempt failed to move. The caller moves the BGE
 * image's `edge` first, so the gateways' can lag behind it but never get ahead.
 *
 * `edge` stays for good, with a warning, in the cases no commit will move:
 *
 *   - It names no commit.
 *   - It names one that has left master, after a force push past master's
 *     ruleset. Each commit published is one master moved to, so any two lie on
 *     one line, and GitHub reports such a commit as diverged, or as missing once
 *     it no longer has it.
 *   - The BGE image has none while another package has one. Its `edge` is
 *     written first, so that means someone removed it, and publish leaves a
 *     removal it can see to whoever made it. Every `edge` removed looks like
 *     no publish yet, so only master's tip writes them again, as above.
 *
 * Where two commits stand is `compare`'s answer for `<base>...<head>`, as
 * GitHub's compare gives it: 'identical', 'ahead' when head descends from base,
 * 'behind' when base descends from head, 'diverged', or 'missing' when GitHub
 * doesn't have one of the two. The entry point hands in GitHub's, and the tests
 * a stand-in, so which way round each question is asked is tested too: asked
 * the wrong way, 'ahead' and 'behind' swap, and `edge` would move back. The
 * tip's anything but 'identical' or 'ahead' counts as not on master. An `edge`
 * comparison of any other value throws, rather than guess.
 *
 * @param {{
 *   commit: string,
 *   tip: string,
 *   edge: Published | null,
 *   otherEdges: (string | null)[],
 *   compare: (base: string, head: string) => Promise<string>,
 * }} facts `tip` is master's tip. `edge` is what the BGE image's `edge` holds,
 *   or null when it has none, and `otherEdges` the digest each other package's
 *   `edge` points at, or null for each that has none.
 * @returns {Promise<{ move: boolean, reason: string, warning?: true }>}
 */
async function edgeDecision({ commit, tip, edge, otherEdges, compare }) {
  const onMaster = tip === commit ? 'identical' : await compare(commit, tip);
  if (onMaster !== 'identical' && onMaster !== 'ahead') {
    return { move: false, reason: `master's tip, \`${tip}\`, doesn't contain this commit.` };
  }
  if (edge === null && otherEdges.some((digest) => digest !== null)) {
    return {
      move: false,
      warning: true,
      reason:
        "the BGE image has no `edge`, though another package has one, so which commit `edge` named isn't known. Move `edge` by hand.",
    };
  }
  if (edge === null && tip !== commit) {
    return {
      move: false,
      reason: `no package has an \`edge\`, and only master's tip, now \`${tip}\`, writes the first, since no commit published can be newer than the tip.`,
    };
  }
  if (edge === null) return { move: true, reason: 'there was no `edge` yet.' };

  const revision = namedCommit(edge);
  if (revision === null) {
    return {
      move: false,
      warning: true,
      reason: '`edge` names no commit, so no commit descends from it. Move `edge` by hand.',
    };
  }

  const comparison = revision === commit ? 'identical' : await compare(revision, commit);
  if (comparison === 'identical') {
    return {
      move: true,
      reason:
        '`edge` already names this commit, so only a package whose `edge` an earlier attempt failed to move changes.',
    };
  }
  if (comparison === 'ahead') {
    return { move: true, reason: `this commit descends from \`${revision}\`, which \`edge\` named.` };
  }
  if (comparison === 'behind') {
    return { move: false, reason: `\`edge\` names \`${revision}\`, which descends from this commit.` };
  }
  if (comparison === 'diverged') {
    return {
      move: false,
      warning: true,
      reason: `\`edge\` names \`${revision}\`, which has diverged from this commit. Each commit published is one master moved to, so \`${revision}\` has left master, and no commit will descend from it. Move \`edge\` by hand.`,
    };
  }
  if (comparison === 'missing') {
    return {
      move: false,
      warning: true,
      reason: `\`edge\` names \`${revision}\`, which this repository doesn't have, so no commit descends from it. Move \`edge\` by hand.`,
    };
  }

  throw new Error(`no rule for a comparison of "${comparison}" between \`edge\`'s ${revision} and this commit`);
}

/**
 * The commit every image under a tag names in its revision label, or null when
 * they name none, or disagree. A label that isn't a full commit SHA names none:
 * a build without `REVISION` leaves it empty, and GitHub would compare a branch
 * name as that branch.
 *
 * @param {Published} published
 * @returns {string | null}
 */
function namedCommit(published) {
  const digests = (listedImages(published.manifest) ?? [{ digest: published.digest }]).map((image) => image.digest);
  const named = new Set(digests.map((digest) => published.labels[digest][REVISION_LABEL]));

  const [revision] = named;

  return named.size === 1 && COMMIT.test(revision) ? revision : null;
}

/**
 * Why an index can't be published as this commit's, or [] when it can. It must
 * list exactly the digests the smoke tested, each once, under its own platform
 * and naming this commit, and nothing else: a provenance attestation, for one,
 * would ride in the index as an `unknown/unknown` entry.
 *
 * @param {{
 *   commit: string,
 *   manifest: object,
 *   tested: Record<string, string>,
 *   labels: Record<string, Record<string, string>>,
 * }} facts `tested` maps each platform to the digest tested on it; `labels`
 *   holds the labels of at least the tested images, by digest
 * @returns {string[]} one sentence fragment per problem, each starting "it" or "its"
 */
function publishProblems({ commit, manifest, tested, labels }) {
  const listed = listedImages(manifest);
  if (listed === null) return ['it is a single image, not an index'];

  const problems = [];

  for (const image of listed) {
    const testedDigest = tested[image.platform];
    if (testedDigest === undefined) {
      problems.push(`it lists ${image.digest} for ${image.platform}, which the smoke didn't test`);
    } else if (image.digest !== testedDigest) {
      problems.push(`it lists ${image.digest} for ${image.platform}, where the smoke tested ${testedDigest}`);
    } else {
      const revision = labels[image.digest][REVISION_LABEL];
      if (revision !== commit) {
        problems.push(`its ${image.platform} image names ${revision || 'no commit'}, not ${commit}`);
      }
    }
  }
  for (const platform of Object.keys(tested)) {
    const entries = listed.filter((image) => image.platform === platform).length;
    if (entries === 0) problems.push(`it lists no ${platform} image`);
    if (entries > 1) problems.push(`it lists ${entries} entries for ${platform}, not one`);
  }

  return problems;
}

/**
 * Why `docker buildx imagetools inspect <ref>` failed, from what it printed:
 *
 *   - 'not-found': the tag doesn't exist.
 *   - 'denied': GHCR refused the token, as it does for one that can't read the
 *     package, and can for a package that doesn't exist yet.
 *   - 'unknown': anything else, such as a registry out of reach.
 *
 * @param {string} ref
 * @param {string} stderr
 * @returns {'not-found' | 'denied' | 'unknown'}
 */
function inspectFailure(ref, stderr) {
  if (stderr.includes(`${ref}: not found`)) return 'not-found';
  if (/403 Forbidden|denied/.test(stderr)) return 'denied';

  return 'unknown';
}

/**
 * The tag that names one commit: `sha-` and its first seven characters, as the
 * web client's image has it.
 *
 * @param {string} commit a full commit SHA
 * @returns {string}
 */
function shaTag(commit) {
  if (!COMMIT.test(commit)) throw new Error(`${commit} is not a full commit SHA`);

  return `sha-${commit.slice(0, 7)}`;
}

/**
 * The digests the smoke tested, by package and platform, from build-push's
 * outputs: `toJSON(needs.build-push.outputs)`, one JSON string per arch, each
 * mapping a package to that arch's digest. Each image smoke job pulled and
 * tested exactly its arch's, and publish runs only once both have passed.
 *
 * Every platform publish names must have handed on a digest for every package
 * it names, and nothing else. Otherwise a missing output would publish an index
 * without that platform, and still pass as exactly what was tested, and a
 * package added to the image jobs but not to publish would go untagged unseen.
 *
 * @param {Record<string, string>} outputs
 * @param {{ images: string[], platforms: string[] }} expected package names, and
 *   platforms as `linux/<arch>`
 * @returns {Record<string, Record<string, string>>} package → platform → digest
 */
function testedDigests(outputs, { images, platforms }) {
  for (const arch of Object.keys(outputs)) {
    if (!platforms.includes(`linux/${arch}`)) {
      throw new Error(`build-push handed on digests for linux/${arch}, which this publish does not name`);
    }
  }

  const byPlatform = Object.fromEntries(
    platforms.map((platform) => {
      const output = outputs[platform.split('/')[1]];
      if (!output) throw new Error(`build-push's ${platform} job handed on no digests`);

      const digests = JSON.parse(output);
      for (const image of Object.keys(digests)) {
        if (!images.includes(image)) {
          throw new Error(`build-push's ${platform} job handed on ${image}, which this publish does not name`);
        }
      }

      return [platform, digests];
    }),
  );

  const digest = (image, platform) => {
    const found = byPlatform[platform][image];
    if (!DIGEST.test(found)) {
      const what = found === undefined ? 'no digest' : JSON.stringify(found);
      throw new Error(`build-push's ${platform} job handed on ${what} for ${image}`);
    }

    return found;
  };

  return Object.fromEntries(
    images.map((image) => [
      image,
      Object.fromEntries(platforms.map((platform) => [platform, digest(image, platform)])),
    ]),
  );
}

module.exports = {
  REVISION_LABEL,
  edgeDecision,
  inspectFailure,
  listedImages,
  namedCommit,
  publishProblems,
  reuseDecision,
  shaTag,
  testedDigests,
};
