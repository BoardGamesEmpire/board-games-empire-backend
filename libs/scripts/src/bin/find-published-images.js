#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for build-push in ci.yml (#600). For each image, it looks for
 * this commit's `sha-<short>` from an earlier attempt, and sets one step output
 * per image, named after its package: the platform's digest to test again, or
 * empty to build the image. Pass the platform, then the images:
 *
 *   node find-published-images.js --platform linux/amd64 ghcr.io/boardgamesempire/bge ...
 *
 * It reads GITHUB_SHA, and needs `docker login` to the registry first.
 * Deliberately thin: what it finds means what `image-tags/rules.js` decides.
 */
const { parseArgs } = require('node:util');

const { readTag } = require('../image-tags/registry');
const { reuseDecision, shaTag } = require('../image-tags/rules');
const { annotate, requiredEnv, setOutputs } = require('../image-tags/workflow');

try {
  const { values, positionals: images } = parseArgs({
    options: { platform: { type: 'string' } },
    allowPositionals: true,
  });
  if (!values.platform || images.length === 0) {
    throw new Error('name the platform and the images: --platform linux/amd64 <image>...');
  }

  const commit = requiredEnv('GITHUB_SHA');
  const tag = shaTag(commit);
  const outputs = {};

  for (const image of images) {
    // GHCR can refuse the token for a package that doesn't exist yet, as it
    // does for one the token can't read. A token that can't read the package
    // can't push to it either, so building can't overwrite anything; publish
    // then checks any sha-<short> that does exist against what was tested. The
    // refusal is logged, since after the first run it means something else is
    // wrong.
    const published = readTag(image, tag, {
      missing: ['not-found', 'denied'],
      onMissing: (failure, stderr) => {
        if (failure === 'denied') console.log(`GHCR refused this job's token for ${image}:${tag}: ${stderr}`);
      },
    });
    const decision = reuseDecision({ commit, platform: values.platform, published });
    if (decision.action === 'stop') throw new Error(decision.reason);

    const name = image.slice(image.lastIndexOf('/') + 1);
    if (decision.action === 'reuse') {
      annotate(
        'notice',
        `An earlier attempt published ${image}:${tag}. This run tests its ${values.platform} image, ${decision.digest}, again rather than build another.`,
      );
      outputs[name] = decision.digest;
    } else {
      console.log(`${image}:${tag} isn't published yet, so this run builds it.`);
      outputs[name] = '';
    }
  }

  setOutputs(outputs);
} catch (error) {
  annotate('error', error.message);
  process.exitCode = 1;
}
