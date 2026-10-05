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

## Child processes and gateways

Every e2e suite runs the apps it tests from their built bundles, as child processes (#258):

- `launchChild`, `launchOnFreePort`, `stopChild` and `killOnExit`, from
  `@bge/testing-e2e/child-process`, launch and stop a bundle. `api-e2e` runs the API and the worker
  on them. `igdb-gateway-e2e` calls `launchChild` directly, against a token endpoint that answers
  with an error, to check that a gateway whose boot fails exits 1.
- `useGateway`, from `@bge/testing-e2e/gateway`, runs a game gateway for one spec file, on a free
  port, and hands out a gRPC client once the gateway answers `Check` with `SERVING`. The
  `boardgamegeek-gateway-e2e` and `igdb-gateway-e2e` suites are built on it.

```ts
import { useGateway } from '@bge/testing-e2e/gateway';

const gateway = useGateway({
  app: 'boardgamegeek-gateway',
  label: 'BoardGameGeek gateway',
  hostEnv: 'BOARDGAMEGEEK_GATEWAY_GRPC_HOST',
  portEnv: 'BOARDGAMEGEEK_GATEWAY_GRPC_PORT',
  env: () => ({ ...process.env, BOARDGAMEGEEK_API_KEY: 'e2e-placeholder-key' }),
});

it('serves', async () => {
  await expect(gateway().check()).resolves.toEqual({ status: 'SERVING' });
});
```

The launcher has its own subpath, rather than a place in the package root, because Jest loads
global setup and teardown with Node's own resolver. That resolver cannot follow the root's `.js`
specifiers to their `.ts` sources, so `child-process.ts` imports Node built-ins only. The same
limit is why gateways launch per spec file rather than from global setup.

The gateway helper has its own subpath too, so the `api-e2e` specs that import the root do not
each load the gRPC stack. Jest loads modules afresh for every spec file.
