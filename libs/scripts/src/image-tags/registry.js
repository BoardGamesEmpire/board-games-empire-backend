'use strict';
/**
 * The registry calls the image entry points make (#600), through
 * `docker buildx imagetools` and the credentials `docker login` stored. Nothing
 * here decides anything: what a result means is `rules.js`'s.
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const { inspectFailure, listedImages } = require('./rules');

/**
 * How long one call may wait on the registry. Neither buildx nor the registry
 * client under it times out a response that never comes, so without this a
 * stalled registry would hold the job, and publish's queue behind it, until the
 * job's own timeout, with nothing in the log to say which call it was.
 */
const TIMEOUT_MS = 120_000;

function imagetools(args, { encoding = 'utf8' } = {}) {
  try {
    return execFileSync('docker', ['buildx', 'imagetools', ...args], {
      encoding,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
      timeout: TIMEOUT_MS,
    });
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      error.message = `docker buildx imagetools ${args.join(' ')} had no answer within ${TIMEOUT_MS / 1000} seconds`;
    }

    throw error;
  }
}

/**
 * A tag's manifest, exactly as the registry serves it, and its digest, or null
 * when the tag doesn't exist. `--raw` prints the registry's bytes unchanged, so
 * their SHA-256 is the digest the tag points at. `missing` lists the failures
 * that mean it doesn't exist (see `inspectFailure`), and `onMissing` hears
 * which one it was; any other failure throws.
 */
function readManifest(ref, missing, onMissing) {
  let raw;
  try {
    raw = imagetools(['inspect', '--raw', ref], { encoding: 'buffer' });
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    const failure = inspectFailure(ref, stderr);
    if (missing.includes(failure)) {
      onMissing?.(failure, stderr);
      return null;
    }

    throw new Error(`could not read ${ref}: ${stderr || error.message}`);
  }

  return {
    digest: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
    manifest: JSON.parse(raw.toString('utf8')),
  };
}

/**
 * An image's labels, read by its digest: `{}` when it has none.
 *
 * @param {string} ref `<image>@<digest>` of one platform's image
 * @returns {Record<string, string>}
 */
function readLabels(ref) {
  let labels;
  try {
    labels = imagetools(['inspect', ref, '--format', '{{json .Image.Config.Labels}}']);
  } catch (error) {
    throw new Error(`could not read the labels of ${ref}: ${String(error.stderr ?? '').trim() || error.message}`);
  }

  return JSON.parse(labels) ?? {};
}

/**
 * What `<image>:<tag>` points at, as `{ ref, digest, manifest }`, without the
 * labels of the images it lists, or null when the tag doesn't exist.
 *
 * @param {string} image
 * @param {string} tag
 * @param {{ missing?: string[], onMissing?: (failure: string, stderr: string) => void }} [options]
 *   the failures that mean the tag doesn't exist, only 'not-found' unless
 *   given, and what to tell when one of them is the answer
 */
function readIndex(image, tag, { missing = ['not-found'], onMissing } = {}) {
  const ref = `${image}:${tag}`;
  const read = readManifest(ref, missing, onMissing);

  return read === null ? null : { ref, ...read };
}

/**
 * What `<image>:<tag>` holds, with the labels of each image it lists, or null
 * when it doesn't exist. Takes `readIndex`'s options.
 *
 * @returns {import('./rules').Published | null}
 */
function readTag(image, tag, options) {
  const read = readIndex(image, tag, options);
  if (read === null) return null;

  const digests = (listedImages(read.manifest) ?? [{ digest: read.digest }]).map((listed) => listed.digest);
  const labels = Object.fromEntries(digests.map((digest) => [digest, readLabels(`${image}@${digest}`)]));

  return { ...read, labels };
}

/** The digest `<image>:<tag>` points at, or null when the tag doesn't exist. */
function readDigest(image, tag) {
  return readIndex(image, tag)?.digest ?? null;
}

/**
 * The index `docker buildx imagetools create` would write for `sources`, one
 * `<image>@<digest>` per platform, without writing it.
 */
function planIndex(sources) {
  return JSON.parse(imagetools(['create', '--dry-run', ...sources]));
}

/**
 * Writes `ref` to point at what `sources` name: an index of them when there
 * are several, or, for a single index, that same index under one more tag.
 */
function writeTag(ref, sources) {
  imagetools(['create', '--tag', ref, ...sources]);
}

module.exports = { planIndex, readDigest, readIndex, readLabels, readTag, writeTag };
