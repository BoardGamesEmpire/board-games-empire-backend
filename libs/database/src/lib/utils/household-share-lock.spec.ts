import { lockLiveHousehold } from './household-share-lock';

describe('lockLiveHousehold', () => {
  const tx = { $queryRaw: jest.fn() };
  const client = tx as unknown as Parameters<typeof lockLiveHousehold>[0];

  afterEach(() => jest.clearAllMocks());

  it('reports a live household when the lock finds its row', async () => {
    tx.$queryRaw.mockResolvedValue([{ id: 'hh-1' }]);

    await expect(lockLiveHousehold(client, 'hh-1')).resolves.toBe(true);
  });

  it('reports a missing or soft-deleted household as not live, and throws nothing', async () => {
    // Each caller owes a different answer for a dead household: the household
    // lib a 404, quota and webhook create a 403, the plugin runtime its own
    // typed error. So the lock reports and the caller decides.
    tx.$queryRaw.mockResolvedValue([]);

    await expect(lockLiveHousehold(client, 'hh-1')).resolves.toBe(false);
  });

  it("takes the lock on the caller's transaction, binding the household id", async () => {
    tx.$queryRaw.mockResolvedValue([{ id: 'hh-1' }]);

    await lockLiveHousehold(client, 'hh-1');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][0]).toEqual(expect.objectContaining({ values: ['hh-1'] }));
  });
});
