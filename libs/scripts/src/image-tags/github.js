'use strict';
/**
 * The GitHub API calls publish makes (#600), with the job's token. They use
 * Node's own `fetch`, since the runner runs these scripts with no install.
 */

const COMPARISONS = new Set(['identical', 'ahead', 'behind', 'diverged']);

/**
 * @typedef {object} GitHub
 * @property {string} apiUrl  `GITHUB_API_URL`
 * @property {string} repository  `<owner>/<name>`
 * @property {string} [token]  left out, the calls go unauthenticated, which a public repository allows
 */

async function get(github, path) {
  const url = `${github.apiUrl}/repos/${github.repository}${path}`;
  try {
    return await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'bge-image-tags',
        'x-github-api-version': '2022-11-28',
        ...(github.token && { authorization: `Bearer ${github.token}` }),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // fetch says only "fetch failed"; what failed is in its cause.
    throw new Error(`GitHub didn't answer ${url}: ${error.cause?.message ?? error.message}`);
  }
}

async function failure(response, what) {
  return new Error(`GitHub answered ${response.status} for ${what}: ${(await response.text()).slice(0, 500)}`);
}

/**
 * The commit a branch points at now.
 *
 * @param {GitHub} github
 * @param {string} branch
 * @returns {Promise<string>}
 */
async function branchTip(github, branch) {
  const response = await get(github, `/git/ref/heads/${branch}`);
  if (!response.ok) throw await failure(response, `${branch}'s tip`);

  return (await response.json()).object.sha;
}

/**
 * GitHub's compare status for `<base>...<head>`: 'ahead' when head descends
 * from base, 'behind' when base descends from head, 'identical' or 'diverged';
 * or 'missing' when GitHub doesn't have one of the two commits. One commit per
 * page, since only the status is read.
 *
 * @param {GitHub} github
 * @param {string} base
 * @param {string} head
 * @returns {Promise<string>}
 */
async function compare(github, base, head) {
  const response = await get(github, `/compare/${base}...${head}?per_page=1`);
  if (response.status === 404) return 'missing';
  if (!response.ok) throw await failure(response, `${base}...${head}`);

  const { status } = await response.json();
  if (!COMPARISONS.has(status)) throw new Error(`GitHub compared ${base}...${head} as "${status}"`);

  return status;
}

module.exports = { branchTip, compare };
