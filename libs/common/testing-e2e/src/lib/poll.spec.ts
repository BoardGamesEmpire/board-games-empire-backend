import { pollUntil } from './poll.js';

describe('pollUntil', () => {
  it('resolves with the first defined probe result without waiting an interval', async () => {
    const probe = jest.fn<Promise<string | undefined>, []>().mockResolvedValue('ready');

    const started = Date.now();
    const result = await pollUntil(probe, { description: 'immediate readiness', intervalMs: 5_000 });

    expect(result).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(1);
    // A generous bound: an immediate hit must not pay the interval.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('retries until the probe produces a value', async () => {
    const probe = jest
      .fn<Promise<number | undefined>, []>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(42);

    const result = await pollUntil(probe, { description: 'third-try value', intervalMs: 5 });

    expect(result).toBe(42);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('times out with the caller-supplied description in the error', async () => {
    const probe = jest.fn<Promise<string | undefined>, []>().mockResolvedValue(undefined);

    await expect(
      pollUntil(probe, { description: "user 'alice' to be provisioned", timeoutMs: 30, intervalMs: 5 }),
    ).rejects.toThrow(/Timed out after 30ms waiting for user 'alice' to be provisioned/);
  });

  it('propagates probe rejections immediately rather than retrying them', async () => {
    const probe = jest.fn<Promise<string | undefined>, []>().mockRejectedValue(new Error('database gone'));

    await expect(pollUntil(probe, { description: 'anything', timeoutMs: 500, intervalMs: 5 })).rejects.toThrow(
      'database gone',
    );

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('treats null as a value, not as absence — only undefined means "not yet"', async () => {
    const probe = jest.fn<Promise<string | null | undefined>, []>().mockResolvedValue(null);

    await expect(pollUntil(probe, { description: 'a null result', intervalMs: 5 })).resolves.toBeNull();
  });
});
