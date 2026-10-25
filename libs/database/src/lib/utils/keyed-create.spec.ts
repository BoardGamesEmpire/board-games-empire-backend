import { createOrReplay, normalizeClientRequestId } from './keyed-create';
import { uniqueViolation, uniqueViolationWithoutMeta } from './prisma-error.fixtures';

interface Row {
  readonly id: string;
}

const created: Row = { id: 'created' };

/** A keyed create under 'k-1' whose lookup misses and whose create succeeds, until a case says otherwise. */
function options(clientRequestId: string | undefined = 'k-1') {
  return {
    clientRequestId,
    find: jest.fn<Promise<Row | null>, [string]>().mockResolvedValue(null),
    create: jest.fn<Promise<Row>, []>().mockResolvedValue(created),
    logger: { warn: jest.fn<void, [string]>(), debug: jest.fn<void, [string]>() },
    label: 'test create',
  };
}

describe('normalizeClientRequestId (#252)', () => {
  // A blank key is not a key. Persisting '' would put every keyless in-process
  // create by a user into one bucket, and the second would replay the first.
  it.each([[undefined], [null], [''], ['   ']])('reads %p as no key', (raw) => {
    expect(normalizeClientRequestId(raw)).toBeUndefined();
  });

  it('trims surrounding whitespace, so a padded retry lands in the same bucket (#252)', () => {
    expect(normalizeClientRequestId('  k-1 ')).toBe('k-1');
  });
});

describe('createOrReplay (#252)', () => {
  it('runs an unkeyed create once and never looks anything up', async () => {
    const opts = { ...options(), clientRequestId: undefined };

    await expect(createOrReplay(opts)).resolves.toEqual({ row: created, replayed: false });
    expect(opts.create).toHaveBeenCalledTimes(1);
    expect(opts.find).not.toHaveBeenCalled();
  });

  // The lookup runs before the create, so a check that has changed since the
  // original (a household deleted, a household grant revoked) cannot turn a replay
  // into a refusal (#252).
  it('returns the row already under the key without running the create', async () => {
    const existing: Row = { id: 'existing' };
    const opts = options();
    opts.find.mockResolvedValue(existing);

    await expect(createOrReplay(opts)).resolves.toEqual({ row: existing, replayed: true });
    expect(opts.create).not.toHaveBeenCalled();
    expect(opts.find).toHaveBeenCalledTimes(1);
    expect(opts.find).toHaveBeenCalledWith('k-1');
  });

  it('runs the create when nothing is under the key yet', async () => {
    const opts = options();

    await expect(createOrReplay(opts)).resolves.toEqual({ row: created, replayed: false });
    expect(opts.create).toHaveBeenCalledTimes(1);
  });

  // Two identical requests both miss the first lookup. The second insert waits
  // on the first's uncommitted unique entry and fails once it commits, so the
  // second lookup finds the row the first one made.
  it('replays the row a concurrent duplicate committed when the create trips the unique', async () => {
    const existing: Row = { id: 'existing' };
    const opts = options();
    opts.find.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    opts.create.mockRejectedValue(uniqueViolationWithoutMeta());

    await expect(createOrReplay(opts)).resolves.toEqual({ row: existing, replayed: true });
    expect(opts.find).toHaveBeenCalledTimes(2);
    expect(opts.logger.warn).not.toHaveBeenCalled();
  });

  // The row decides, not the error's shape: under the driver adapter a P2002's
  // `meta.target` is empty (#257), so the whole `meta` goes into the log line
  // for whoever has to work out which unique it was.
  it('rethrows a unique violation with no row under the key, and says so at warn', async () => {
    const violation = uniqueViolation({ fields: ['other_column'] });
    const opts = options();
    opts.create.mockRejectedValue(violation);

    await expect(createOrReplay(opts)).rejects.toBe(violation);
    expect(opts.find).toHaveBeenCalledTimes(2);
    expect(opts.logger.warn).toHaveBeenCalledTimes(1);

    const [message] = opts.logger.warn.mock.calls[0];
    expect(message).toContain('test create');
    expect(message).toContain('meta=');
    expect(message).toContain('other_column');
  });

  it('rethrows any other failure without a second lookup', async () => {
    const failure = new Error('connection reset');
    const opts = options();
    opts.create.mockRejectedValue(failure);

    await expect(createOrReplay(opts)).rejects.toBe(failure);
    expect(opts.find).toHaveBeenCalledTimes(1);
    expect(opts.logger.warn).not.toHaveBeenCalled();
  });
});
