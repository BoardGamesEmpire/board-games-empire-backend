import { RiskLevel, SystemRole } from '@bge/database';
import { I18N_CATALOG_DIR } from '@bge/i18n';
import type { Actors } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';
import { mintApiKey } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import type { HttpResponseLike } from '../support/wire';
import { envelopeFailure, isRecord } from '../support/wire';

const PATH = '/api/api-keys/grantable';
const REQUEST = `GET ${PATH}`;

interface GrantablePermissionWire {
  readonly description: string;
  readonly pinnable: boolean;
  readonly riskLevel: RiskLevel;
  readonly slug: string;
}

const fail = envelopeFailure('apps/api-e2e/src/api-key/grantable.spec.ts');
const RISK_LEVELS: ReadonlySet<unknown> = new Set(Object.values(RiskLevel));

/** The list's entries, or a failure naming what in the envelope changed. */
function grantableEnvelope(response: HttpResponseLike): readonly GrantablePermissionWire[] {
  const body = response.body;
  if (!isRecord(body) || !Array.isArray(body['permissions'])) {
    return fail('the body has no permissions array', REQUEST, response);
  }

  return body['permissions'].map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry['slug'] !== 'string' ||
      typeof entry['description'] !== 'string' ||
      typeof entry['pinnable'] !== 'boolean' ||
      !RISK_LEVELS.has(entry['riskLevel'])
    ) {
      return fail('an entry is not { slug, description, riskLevel, pinnable }', REQUEST, response);
    }

    return {
      slug: entry['slug'],
      description: entry['description'],
      // Checked against the enum's values above.
      riskLevel: entry['riskLevel'] as RiskLevel,
      pinnable: entry['pinnable'],
    };
  });
}

/** The English `permissions` catalog as the server ships it, read at run time (#1417). */
function shippedDescriptions(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(I18N_CATALOG_DIR, 'en', 'permissions.json'), 'utf8'));
}

/**
 * The permissions the signed-in user's API key may hold, as the key creation
 * screen lists them (#1417): each with its plain-language description, its
 * risk level, and whether its type accepts a pin. Only the user in person
 * reads it; a key acts for its owner but is not the owner.
 *
 * Every household is arranged before its members send a request: the API
 * caches each user's permission graph on first use (#256).
 */
describe('GET /api/api-keys/grantable (#1417)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const grantableFor = async (headers: Readonly<Record<string, string>>) =>
    grantableEnvelope(await request(baseUrl).get(PATH).set(headers).expect(200));

  const entry = (list: readonly GrantablePermissionWire[], slug: string) =>
    list.find((permission) => permission.slug === slug);

  it("a user's list holds read:game and read:game:public, not read:public_content", async () => {
    const user = await actors.user();

    const list = await grantableFor(user.headers);
    const slugs = list.map(({ slug }) => slug);

    expect(slugs).toEqual(expect.arrayContaining(['read:game', 'read:game:public']));
    expect(slugs).not.toContain('read:public_content');
    expect(slugs).toEqual([...slugs].sort());
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // A permission on `all` reaches every type, so a key never holds one (#1418).
  it("an admin's list leaves out read:public_content, a permission on all (#1418)", async () => {
    const admin = await actors.admin();

    expect(entry(await grantableFor(admin.headers), 'read:public_content')).toBeUndefined();
  });

  // The Owner role holds only manage:all, so its list has nothing to offer.
  it("the owner's list leaves out manage:all, a permission on all (#1418)", async () => {
    const owner = await actors.owner();

    expect(entry(await grantableFor(owner.headers), 'manage:all')).toBeUndefined();
  });

  // A Critical permission is offered; it adds friction at create, never exclusion.
  it("an admin's list holds manage:safe_http_policy with riskLevel Critical (#1418)", async () => {
    const admin = await actors.admin();

    expect(entry(await grantableFor(admin.headers), 'manage:safe_http_policy')).toEqual(
      expect.objectContaining({ riskLevel: RiskLevel.Critical, pinnable: false }),
    );
  });

  // The description is the localized catalog text a screen reader announces,
  // never the permission's editable reason. Every entry is checked, so a
  // catalog gap shows here as the slug whose description is missing (#1417).
  it("each description is the permissions catalog's English text", async () => {
    const user = await actors.user();
    const catalog = shippedDescriptions();
    const list = await grantableFor(user.headers);

    expect(list.length).toBeGreaterThan(0);

    for (const { slug, description } of list) {
      // The slug rides along so a failure names the permission.
      expect([slug, typeof catalog[slug]]).toEqual([slug, 'string']);
      expect([slug, description]).toEqual([slug, catalog[slug]]);
    }
  });

  it('read:household_ban is pinnable and create:household_ban is not', async () => {
    const householdOwner = await actors.user();
    const admin = await actors.user();
    await actors.householdWithMembers({
      owner: householdOwner,
      members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
    });

    const list = await grantableFor(admin.headers);

    expect(entry(list, 'read:household_ban')).toEqual(expect.objectContaining({ pinnable: true }));
    expect(entry(list, 'create:household_ban')).toEqual(expect.objectContaining({ pinnable: false }));
  });

  it('a request carrying an API key is refused with 403', async () => {
    const user = await actors.user();
    const key = await mintApiKey(baseUrl, db.client, user);

    await request(baseUrl).get(PATH).set(key.headers).expect(403);
  });

  // The global guard refuses a request with no session and no key before the route runs.
  it('an unauthenticated request is refused', async () => {
    await request(baseUrl).get(PATH).expect(401);
  });
});
