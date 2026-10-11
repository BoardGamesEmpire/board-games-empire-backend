'use strict';
const {
  edgeDecision,
  inspectFailure,
  namedCommit,
  publishProblems,
  reuseDecision,
  shaTag,
  testedDigests,
} = require('./rules');

const COMMIT = '3e573550b1d7f0c2a9e4d6b8c0a2e4f6a8b0c2d4';
/** A commit sharing COMMIT's first seven characters: the collision a sha tag can't rule out. */
const OTHER = '3e5735509a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d';
/** Master's tip, when it isn't COMMIT. */
const TIP = '8c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d';
/** The commit `edge` names, when it isn't COMMIT. */
const EDGE = '576450a7d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6';
const AMD64 = `sha256:${'a'.repeat(64)}`;
const ARM64 = `sha256:${'b'.repeat(64)}`;
const INDEX = `sha256:${'c'.repeat(64)}`;
const UNTESTED = `sha256:${'d'.repeat(64)}`;

/** An OCI index of one image per `[platform, digest]`, as `docker buildx imagetools create` writes it. */
function index(...images) {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: images.map(([platform, digest]) => {
      const [os, architecture, variant] = platform.split('/');
      return {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest,
        size: 857,
        platform: { architecture, os, ...(variant && { variant }) },
      };
    }),
  };
}

/** An image's labels, as the Dockerfile writes them, naming `revision`. */
function labels(revision) {
  return {
    'org.opencontainers.image.revision': revision,
    'org.opencontainers.image.source': 'https://github.com/BoardGamesEmpire/board-games-empire-backend',
    'org.opencontainers.image.version': '0.0.0',
  };
}

/** What a tag holds when it is an index of `[platform, digest, labels]` images. */
function publishedIndex(...images) {
  return {
    ref: 'ghcr.io/boardgamesempire/bge:sha-3e57355',
    digest: INDEX,
    manifest: index(...images),
    labels: Object.fromEntries(images.map(([, digest, imageLabels]) => [digest, imageLabels])),
  };
}

describe('reuseDecision', () => {
  it("builds an image when this commit's sha tag doesn't exist yet", () => {
    expect(reuseDecision({ commit: COMMIT, platform: 'linux/amd64', published: null })).toEqual({ action: 'build' });
  });

  it("tests this platform's image from an earlier attempt again when the sha tag names this commit", () => {
    const published = publishedIndex(['linux/amd64', AMD64, labels(COMMIT)], ['linux/arm64', ARM64, labels(COMMIT)]);

    expect(reuseDecision({ commit: COMMIT, platform: 'linux/arm64', published })).toEqual({
      action: 'reuse',
      digest: ARM64,
    });
  });

  it('stops the job when the sha tag names another commit, since a sha tag never moves', () => {
    const published = publishedIndex(['linux/amd64', AMD64, labels(OTHER)], ['linux/arm64', ARM64, labels(OTHER)]);

    expect(reuseDecision({ commit: COMMIT, platform: 'linux/amd64', published })).toEqual({
      action: 'stop',
      reason: `ghcr.io/boardgamesempire/bge:sha-3e57355 names ${OTHER}, not ${COMMIT}, and a sha tag never moves.`,
    });
  });

  it('stops the job when the sha tag lists no image for this platform', () => {
    const published = publishedIndex(['linux/amd64', AMD64, labels(COMMIT)]);

    expect(reuseDecision({ commit: COMMIT, platform: 'linux/arm64', published })).toEqual({
      action: 'stop',
      reason: 'ghcr.io/boardgamesempire/bge:sha-3e57355 lists no linux/arm64 image, and a sha tag never moves.',
    });
  });

  it("takes an arm64 image listed with arm64's default variant, v8, as the linux/arm64 image", () => {
    const published = publishedIndex(['linux/amd64', AMD64, labels(COMMIT)], ['linux/arm64/v8', ARM64, labels(COMMIT)]);

    expect(reuseDecision({ commit: COMMIT, platform: 'linux/arm64', published })).toEqual({
      action: 'reuse',
      digest: ARM64,
    });
  });

  it('stops the job when the sha tag holds a single image rather than an index', () => {
    const published = {
      ref: 'ghcr.io/boardgamesempire/bge:sha-3e57355',
      digest: AMD64,
      manifest: { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', layers: [] },
      labels: { [AMD64]: labels(COMMIT) },
    };

    expect(reuseDecision({ commit: COMMIT, platform: 'linux/amd64', published })).toEqual({
      action: 'stop',
      reason: 'ghcr.io/boardgamesempire/bge:sha-3e57355 is a single image, not an index, and a sha tag never moves.',
    });
  });

  it('stops the job when the image under the sha tag has no revision label', () => {
    const published = publishedIndex(['linux/amd64', AMD64, {}], ['linux/arm64', ARM64, {}]);

    expect(reuseDecision({ commit: COMMIT, platform: 'linux/amd64', published })).toEqual({
      action: 'stop',
      reason: `ghcr.io/boardgamesempire/bge:sha-3e57355 names no commit, not ${COMMIT}, and a sha tag never moves.`,
    });
  });
});

describe('edgeDecision', () => {
  /**
   * GitHub's compare in a repository that holds `line`, oldest first, each
   * commit descending from the ones before it, and `beside`, commits on no
   * line with them, as a force push leaves them. `<base>...<head>` is 'ahead'
   * when head descends from base, 'behind' when base descends from head,
   * 'diverged' when one is beside the line, and 'missing' when the repository
   * doesn't have one of them.
   */
  function repository({ line, beside = [] }) {
    return async (base, head) => {
      if (![base, head].every((sha) => line.includes(sha) || beside.includes(sha))) return 'missing';
      if (base === head) return 'identical';
      if (beside.includes(base) || beside.includes(head)) return 'diverged';

      return line.indexOf(head) > line.indexOf(base) ? 'ahead' : 'behind';
    };
  }

  /** What the BGE image's `edge` holds when both its images name `revision`. */
  function edgeNaming(revision) {
    return {
      ...publishedIndex(['linux/amd64', AMD64, labels(revision)], ['linux/arm64', ARM64, labels(revision)]),
      ref: 'ghcr.io/boardgamesempire/bge:edge',
    };
  }

  /** Neither gateway has an `edge`. */
  const NO_OTHER_EDGES = [null, null];

  it("moves edge when there is none yet and the commit is master's tip", async () => {
    const compare = repository({ line: [COMMIT] });

    await expect(
      edgeDecision({ commit: COMMIT, tip: COMMIT, edge: null, otherEdges: NO_OTHER_EDGES, compare }),
    ).resolves.toEqual({
      move: true,
      reason: 'there was no `edge` yet.',
    });
  });

  it('leaves edge where it is, with a warning, when the BGE image has none but another package has one', async () => {
    const compare = repository({ line: [COMMIT] });

    await expect(
      edgeDecision({ commit: COMMIT, tip: COMMIT, edge: null, otherEdges: [null, INDEX], compare }),
    ).resolves.toEqual({
      move: false,
      warning: true,
      reason:
        "the BGE image has no `edge`, though another package has one, so which commit `edge` named isn't known. Move `edge` by hand.",
    });
  });

  it.each([
    ['has left master', { line: [EDGE, TIP], beside: [COMMIT] }],
    ["descends from master's tip, which a force push took back", { line: [TIP, COMMIT] }],
  ])("leaves edge where it is when master's tip doesn't contain the commit, which %s", async (_, history) => {
    const compare = repository(history);

    await expect(
      edgeDecision({ commit: COMMIT, tip: TIP, edge: null, otherEdges: NO_OTHER_EDGES, compare }),
    ).resolves.toEqual({
      move: false,
      reason: `master's tip, \`${TIP}\`, doesn't contain this commit.`,
    });
  });

  it('moves edge when the commit descends from the one edge names, though master has moved on since', async () => {
    const compare = repository({ line: [EDGE, COMMIT, TIP] });

    await expect(
      edgeDecision({ commit: COMMIT, tip: TIP, edge: edgeNaming(EDGE), otherEdges: NO_OTHER_EDGES, compare }),
    ).resolves.toEqual({
      move: true,
      reason: `this commit descends from \`${EDGE}\`, which \`edge\` named.`,
    });
  });

  it('leaves edge where it is when edge names a newer commit, so a late run of an older one never moves it back', async () => {
    const compare = repository({ line: [COMMIT, EDGE, TIP] });

    await expect(
      edgeDecision({ commit: COMMIT, tip: TIP, edge: edgeNaming(EDGE), otherEdges: NO_OTHER_EDGES, compare }),
    ).resolves.toEqual({
      move: false,
      reason: `\`edge\` names \`${EDGE}\`, which descends from this commit.`,
    });
  });

  it('leaves edge where it is, with a warning, when edge names a commit that has left master', async () => {
    const compare = repository({ line: [COMMIT], beside: [EDGE] });

    await expect(
      edgeDecision({ commit: COMMIT, tip: COMMIT, edge: edgeNaming(EDGE), otherEdges: NO_OTHER_EDGES, compare }),
    ).resolves.toEqual({
      move: false,
      warning: true,
      reason: `\`edge\` names \`${EDGE}\`, which has diverged from this commit. Each commit published is one master moved to, so \`${EDGE}\` has left master, and no commit will descend from it. Move \`edge\` by hand.`,
    });
  });

  it("moves edge when edge already names the commit, so a re-run brings up a package whose edge didn't move", async () => {
    const compare = repository({ line: [COMMIT, TIP] });

    await expect(
      edgeDecision({ commit: COMMIT, tip: TIP, edge: edgeNaming(COMMIT), otherEdges: [null, INDEX], compare }),
    ).resolves.toEqual({
      move: true,
      reason:
        '`edge` already names this commit, so only a package whose `edge` an earlier attempt failed to move changes.',
    });
  });

  it("leaves edge where it is, with a warning, when edge names a commit the repository doesn't have", async () => {
    const compare = repository({ line: [COMMIT] });

    await expect(
      edgeDecision({ commit: COMMIT, tip: COMMIT, edge: edgeNaming(EDGE), otherEdges: NO_OTHER_EDGES, compare }),
    ).resolves.toEqual({
      move: false,
      warning: true,
      reason: `\`edge\` names \`${EDGE}\`, which this repository doesn't have, so no commit descends from it. Move \`edge\` by hand.`,
    });
  });

  it('leaves edge where it is, with a warning, when edge names no commit', async () => {
    const compare = repository({ line: [COMMIT] });

    await expect(
      edgeDecision({ commit: COMMIT, tip: COMMIT, edge: edgeNaming(''), otherEdges: NO_OTHER_EDGES, compare }),
    ).resolves.toEqual({
      move: false,
      warning: true,
      reason: '`edge` names no commit, so no commit descends from it. Move `edge` by hand.',
    });
  });

  it('refuses to guess at a comparison it does not know', async () => {
    const compare = async (base, head) => (base === head ? 'identical' : 'unrelated');

    await expect(
      edgeDecision({ commit: COMMIT, tip: COMMIT, edge: edgeNaming(EDGE), otherEdges: NO_OTHER_EDGES, compare }),
    ).rejects.toThrow(`no rule for a comparison of "unrelated" between \`edge\`'s ${EDGE} and this commit`);
  });
});

describe('namedCommit', () => {
  it('is the commit every image under the tag names', () => {
    const published = publishedIndex(['linux/amd64', AMD64, labels(EDGE)], ['linux/arm64', ARM64, labels(EDGE)]);

    expect(namedCommit(published)).toBe(EDGE);
  });

  it("is null when the tag's images name different commits", () => {
    const published = publishedIndex(['linux/amd64', AMD64, labels(EDGE)], ['linux/arm64', ARM64, labels(COMMIT)]);

    expect(namedCommit(published)).toBeNull();
  });

  it.each([
    ['empty, as a build without REVISION leaves it', ''],
    ['a branch name, which GitHub would compare as the branch', 'master'],
    ['an abbreviated commit', '576450a7'],
  ])('is null when the revision label is %s', (_, revision) => {
    const published = publishedIndex(
      ['linux/amd64', AMD64, labels(revision)],
      ['linux/arm64', ARM64, labels(revision)],
    );

    expect(namedCommit(published)).toBeNull();
  });

  it("is a single image's own commit when the tag holds one rather than an index", () => {
    const published = {
      ref: 'ghcr.io/boardgamesempire/bge:edge',
      digest: AMD64,
      manifest: { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', layers: [] },
      labels: { [AMD64]: labels(EDGE) },
    };

    expect(namedCommit(published)).toBe(EDGE);
  });
});

describe('publishProblems', () => {
  const tested = { 'linux/amd64': AMD64, 'linux/arm64': ARM64 };
  const testedLabels = { [AMD64]: labels(COMMIT), [ARM64]: labels(COMMIT) };

  it('finds none when the index lists exactly the tested digests, under their platforms, each naming the commit', () => {
    const manifest = index(['linux/amd64', AMD64], ['linux/arm64', ARM64]);

    expect(publishProblems({ commit: COMMIT, manifest, tested, labels: testedLabels })).toEqual([]);
  });

  it('names a platform whose listed digest is not the one the smoke tested', () => {
    const manifest = index(['linux/amd64', AMD64], ['linux/arm64', UNTESTED]);
    const imageLabels = { ...testedLabels, [UNTESTED]: labels(COMMIT) };

    expect(publishProblems({ commit: COMMIT, manifest, tested, labels: imageLabels })).toEqual([
      `it lists ${UNTESTED} for linux/arm64, where the smoke tested ${ARM64}`,
    ]);
  });

  it('names a tested platform the index leaves out', () => {
    const manifest = index(['linux/amd64', AMD64]);

    expect(publishProblems({ commit: COMMIT, manifest, tested, labels: testedLabels })).toEqual([
      'it lists no linux/arm64 image',
    ]);
  });

  it('names an entry the smoke never tested, such as an attestation BuildKit attached', () => {
    const manifest = index(['linux/amd64', AMD64], ['linux/arm64', ARM64], ['unknown/unknown', UNTESTED]);

    expect(publishProblems({ commit: COMMIT, manifest, tested, labels: testedLabels })).toEqual([
      `it lists ${UNTESTED} for unknown/unknown, which the smoke didn't test`,
    ]);
  });

  it('names a tested image that names another commit, or none', () => {
    const manifest = index(['linux/amd64', AMD64], ['linux/arm64', ARM64]);
    const imageLabels = { [AMD64]: labels(OTHER), [ARM64]: {} };

    expect(publishProblems({ commit: COMMIT, manifest, tested, labels: imageLabels })).toEqual([
      `its linux/amd64 image names ${OTHER}, not ${COMMIT}`,
      `its linux/arm64 image names no commit, not ${COMMIT}`,
    ]);
  });

  it('names an entry the index lists without a platform, as a nested index would be', () => {
    const manifest = index(['linux/amd64', AMD64], ['linux/arm64', ARM64]);
    manifest.manifests.push({ mediaType: 'application/vnd.oci.image.index.v1+json', digest: UNTESTED, size: 512 });

    expect(publishProblems({ commit: COMMIT, manifest, tested, labels: testedLabels })).toEqual([
      `it lists ${UNTESTED} for no platform, which the smoke didn't test`,
    ]);
  });

  it('names a single image where an index of the tested images belongs', () => {
    const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', layers: [] };

    expect(publishProblems({ commit: COMMIT, manifest, tested, labels: testedLabels })).toEqual([
      'it is a single image, not an index',
    ]);
  });

  it('names a second image listed for a tested platform beside the tested one', () => {
    const manifest = index(['linux/amd64', AMD64], ['linux/arm64', ARM64], ['linux/arm64', UNTESTED]);

    expect(publishProblems({ commit: COMMIT, manifest, tested, labels: testedLabels })).toEqual([
      `it lists ${UNTESTED} for linux/arm64, where the smoke tested ${ARM64}`,
    ]);
  });
});

describe('inspectFailure', () => {
  const ref = 'ghcr.io/boardgamesempire/bge:sha-3e57355';

  it("is 'not-found' when the tag doesn't exist", () => {
    expect(inspectFailure(ref, `ERROR: ${ref}: not found\n`)).toBe('not-found');
  });

  it.each([
    [
      'refuses a token for a package that does not exist yet',
      'ERROR: failed to authorize: failed to fetch anonymous token: unexpected status from GET request to https://ghcr.io/token?scope=repository%3Aboardgamesempire%2Fbge%3Apull&service=ghcr.io: 403 Forbidden\n',
    ],
    ['answers denied', `ERROR: ${ref}: denied: requested access to the resource is denied\n`],
  ])("is 'denied' when GHCR %s", (_, stderr) => {
    expect(inspectFailure(ref, stderr)).toBe('denied');
  });

  it.each([
    ['something other than the tag is not found', `ERROR: ${ref}@sha256:${'e'.repeat(64)}: not found\n`],
    [
      'the registry is out of reach',
      'ERROR: failed to do request: Head "https://ghcr.io/v2/": dial tcp: i/o timeout\n',
    ],
  ])("is 'unknown' when %s", (_, stderr) => {
    expect(inspectFailure(ref, stderr)).toBe('unknown');
  });
});

describe('shaTag', () => {
  it("is sha- and the commit's first seven characters", () => {
    expect(shaTag(COMMIT)).toBe('sha-3e57355');
  });

  it('refuses anything but a full commit SHA', () => {
    expect(() => shaTag('3e57355')).toThrow('3e57355 is not a full commit SHA');
  });
});

describe('testedDigests', () => {
  const GATEWAY_AMD64 = `sha256:${'1'.repeat(64)}`;
  const GATEWAY_ARM64 = `sha256:${'2'.repeat(64)}`;
  const images = ['bge', 'bge-igdb-gateway'];
  const platforms = ['linux/amd64', 'linux/arm64'];

  /** build-push's outputs, as `toJSON(needs.build-push.outputs)` has them: one JSON string per arch. */
  const outputs = (byArch) =>
    Object.fromEntries(Object.entries(byArch).map(([arch, digests]) => [arch, JSON.stringify(digests)]));

  it("reads each platform's tested digests by image", () => {
    const handedOn = outputs({
      amd64: { bge: AMD64, 'bge-igdb-gateway': GATEWAY_AMD64 },
      arm64: { bge: ARM64, 'bge-igdb-gateway': GATEWAY_ARM64 },
    });

    expect(testedDigests(handedOn, { images, platforms })).toEqual({
      bge: { 'linux/amd64': AMD64, 'linux/arm64': ARM64 },
      'bge-igdb-gateway': { 'linux/amd64': GATEWAY_AMD64, 'linux/arm64': GATEWAY_ARM64 },
    });
  });

  it("refuses when a platform's build-push job handed on nothing, rather than publish an index without it", () => {
    const handedOn = outputs({ amd64: { bge: AMD64, 'bge-igdb-gateway': GATEWAY_AMD64 } });

    expect(() => testedDigests(handedOn, { images, platforms })).toThrow(
      "build-push's linux/arm64 job handed on no digests",
    );
  });

  it.each([
    ['no digest', { bge: ARM64 }, 'no digest'],
    ['something other than a digest', { bge: ARM64, 'bge-igdb-gateway': 'latest' }, '"latest"'],
  ])('refuses when a build-push job handed on %s for an image', (_, arm64, found) => {
    const handedOn = outputs({ amd64: { bge: AMD64, 'bge-igdb-gateway': GATEWAY_AMD64 }, arm64 });

    expect(() => testedDigests(handedOn, { images, platforms })).toThrow(
      `build-push's linux/arm64 job handed on ${found} for bge-igdb-gateway`,
    );
  });

  it('refuses a package build-push handed on that the publish does not name', () => {
    const handedOn = outputs({
      amd64: { bge: AMD64, 'bge-igdb-gateway': GATEWAY_AMD64, 'bge-other-gateway': UNTESTED },
      arm64: { bge: ARM64, 'bge-igdb-gateway': GATEWAY_ARM64 },
    });

    expect(() => testedDigests(handedOn, { images, platforms })).toThrow(
      "build-push's linux/amd64 job handed on bge-other-gateway, which this publish does not name",
    );
  });

  it('refuses a platform build-push handed on that the publish does not name', () => {
    const handedOn = outputs({
      amd64: { bge: AMD64, 'bge-igdb-gateway': GATEWAY_AMD64 },
      arm64: { bge: ARM64, 'bge-igdb-gateway': GATEWAY_ARM64 },
      riscv64: { bge: UNTESTED, 'bge-igdb-gateway': UNTESTED },
    });

    expect(() => testedDigests(handedOn, { images, platforms })).toThrow(
      'build-push handed on digests for linux/riscv64, which this publish does not name',
    );
  });
});
