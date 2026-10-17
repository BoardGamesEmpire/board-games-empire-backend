import { JobStatus, JobType, ResourceType } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { batchEnvelope, listBatchesEnvelope } from './import-wire';

/**
 * Which import jobs the import status routes answer with, over the real
 * routes (#515).
 *
 * For a session nothing changed: the `Job` ceiling admits every import job,
 * and the list already named the acting user. What changed is an API key. A
 * key scoped to one job used to list every batch its owner had run, with a raw
 * SQL `total` no ceiling could reach, and read any batch by id. Now the list
 * and its `total` cover only the batches whose base job the key may read, each
 * with only the jobs it may read, and a batch it may read none of is 404.
 *
 * The jobs are arranged directly: an import runs through the coordinator and
 * its workers, and none of that is under test.
 */
describe('import status read scope', () => {
  const baseUrl = requireBaseUrl(process.env);
  const IMPORTS_PATH = '/api/games/import';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const listImports = (caller: Caller) => request(baseUrl).get(IMPORTS_PATH).set(caller.headers);

  const readBatch = (caller: Caller, batchId: string) =>
    request(baseUrl).get(`${IMPORTS_PATH}/${batchId}`).set(caller.headers);

  const job = (userId: string, batchId: string, createdAt: Date, parentJobId: string | null = null) =>
    db.client.job.create({
      data: {
        type: JobType.GameImport,
        status: JobStatus.Completed,
        userId,
        batchId,
        parentJobId,
        createdAt,
        payload: { correlationId: randomUUID(), externalId: randomUUID() },
      },
      select: { id: true },
    });

  /**
   * Two batches. The first started earlier but has an expansion created after
   * the second started, which is how a batch looks once its base job has run
   * and spawned its expansions.
   */
  const arrangeBatches = async (userId: string) => {
    const startedAt = Date.now() - 60 * 60 * 1_000;
    const [first, second] = [randomUUID(), randomUUID()];

    const firstBase = await job(userId, first, new Date(startedAt));
    const secondBase = await job(userId, second, new Date(startedAt + 60_000));
    const expansion = await job(userId, first, new Date(startedAt + 120_000), firstBase.id);

    return { first, second, firstBase: firstBase.id, secondBase: secondBase.id, expansion: expansion.id };
  };

  it("lists its owner every batch, by when each started, with all of its jobs, and no one else's", async () => {
    const [owner, stranger] = await Promise.all([actors.user(), actors.user()]);
    const batches = await arrangeBatches(owner.user.id);
    const strangers = await arrangeBatches(stranger.user.id);

    // The control: a session's ceiling admits every import job, so the owner
    // reads a stranger's batch by id. Only the list's own scope names the
    // acting user, and it alone keeps the stranger's batches off the page.
    batchEnvelope(
      await readBatch(owner, strangers.second).expect(200),
      "GET /api/games/import/:batchId for a stranger's batch",
    );

    const page = listBatchesEnvelope(await listImports(owner).expect(200), 'GET /api/games/import as its owner');

    // By start: the second batch first, although the first holds the newest job.
    expect(page.batches.map((batch) => batch.batchId)).toEqual([batches.second, batches.first]);
    expect(page.total).toBe(2);
    expect(page.batches[1].jobs.map((each) => each.jobId).sort()).toEqual(
      [batches.firstBase, batches.expansion].sort(),
    );
  });

  // The list pages and counts batches by their base job. Were the parent key
  // to detach a deleted base job's expansions instead of deleting them, each
  // would list as another copy of the batch, and `total` would count it.
  it('drops a batch whose base job is deleted, rather than listing its expansions as batches', async () => {
    const owner = await actors.user();
    const batches = await arrangeBatches(owner.user.id);
    await job(owner.user.id, batches.first, new Date(), batches.firstBase);

    await db.client.job.delete({ where: { id: batches.firstBase } });

    const page = listBatchesEnvelope(
      await listImports(owner).expect(200),
      'GET /api/games/import after a base job is deleted',
    );

    expect(page.batches.map((batch) => batch.batchId)).toEqual([batches.second]);
    expect(page.total).toBe(1);
  });

  it('lists a key scoped to one base job only that batch, with only that job, and counts one', async () => {
    const owner = await actors.user();
    const batches = await arrangeBatches(owner.user.id);
    const key = await mintApiKey(baseUrl, db.client, owner, {
      slugs: ['read:job'],
      resourceType: ResourceType.Job,
      resourceId: batches.firstBase,
    });

    const page = listBatchesEnvelope(await listImports(key).expect(200), 'GET /api/games/import with a scoped key');

    expect(page.batches.map((batch) => batch.batchId)).toEqual([batches.first]);
    expect(page.batches[0].jobs.map((each) => each.jobId)).toEqual([batches.firstBase]);
    expect(page.total).toBe(1);
  });

  it('answers a scoped key 404 for a batch it may read none of', async () => {
    const owner = await actors.user();
    const batches = await arrangeBatches(owner.user.id);
    const key = await mintApiKey(baseUrl, db.client, owner, {
      slugs: ['read:job'],
      resourceType: ResourceType.Job,
      resourceId: batches.firstBase,
    });

    // The control: the batch exists, and its owner's session reads it.
    batchEnvelope(await readBatch(owner, batches.second).expect(200), 'GET /api/games/import/:batchId as its owner');

    const scoped = batchEnvelope(
      await readBatch(key, batches.first).expect(200),
      'GET /api/games/import/:batchId with a scoped key',
    );
    expect(scoped.jobs.map((each) => each.jobId)).toEqual([batches.firstBase]);

    await readBatch(key, batches.second).expect(404);
  });
});
