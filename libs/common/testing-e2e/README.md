# @bge/testing-e2e

Persisted, authenticated actor fixtures for the black-box e2e harness (#256, part of epic #254).
Unlike `@bge/testing` — in-memory fixtures for unit specs — everything here creates **real rows
and real credentials** against the harness's ephemeral database and running API server (#255).

## Usage

```ts
import { createActors, type Actors } from '@bge/testing-e2e';
import { SystemRole } from '@bge/database';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const baseUrl = requireBaseUrl(process.env);
let db: TestDatabase;
let actors: Actors;

beforeAll(() => {
  db = createTestDatabase();
  actors = createActors({ baseUrl, prisma: db.client });
});
afterAll(async () => db.close());

it('an owner can list their households', async () => {
  const owner = await actors.user();
  const member = await actors.user();
  await actors.householdWithMembers({
    owner,
    members: [{ actor: member, role: SystemRole.HouseholdMember }],
  });

  await request(baseUrl).get('/api/households').set(owner.headers).expect(200);
});
```

## Rules the factories encode (do not fight them)

- **HTTP-only signup.** Actors are created through `POST /api/auth/sign-up/email` on the running
  server — never through a test-process BetterAuth instance, whose provisioning hook would emit
  into a listener-less process and hand back half-provisioned users.
- **Provisioning is awaited.** The signup response can return before the asynchronous
  `UserProvisioningListener` commits; factories poll for the `UserRole` row and fail loudly on
  timeout.
- **The Owner sentinel.** Provisioning grants `SystemRole.Owner` to the _first_ human user, and
  the isolation sweep truncates users per test — so every factory method first ensures a sentinel
  Owner exists. Specs counting `user` rows must expect this +1 (plus the service account the Owner
  provisioning creates).
- **Ordering rule (ability cache).** Arrange all roles and memberships **before** an actor's first
  authenticated request; the ability cache populates lazily per user and the test process cannot
  evict it. Mutations after a request must go through real HTTP endpoints, which evict server-side.
- **Generated identifiers only.** Never pin ids, usernames, or emails across tests — a pinned id
  lets a stale ability-cache entry from a truncated user be re-derived by a later test (#268).

API-key actors are deliberately absent — deferred to #270 while the key permission model is
unbuilt; restricted-key scoping is #266.
