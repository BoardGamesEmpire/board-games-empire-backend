import { StorageService } from '@bge/storage';
import { StorageUnavailableError } from '@boardgamesempire/storage-contract';
import { Provider } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { StorageHealthIndicator } from './storage.health-indicator';

type MockStorage = { ping: jest.Mock };

async function buildIndicator(storage: MockStorage | null): Promise<StorageHealthIndicator> {
  const providers: Provider[] = [
    StorageHealthIndicator,
    ...(storage ? [{ provide: StorageService, useValue: storage }] : []),
  ];
  const module = await Test.createTestingModule({ imports: [TerminusModule], providers }).compile();
  return module.get(StorageHealthIndicator);
}

describe('StorageHealthIndicator', () => {
  it('returns up when ping resolves', async () => {
    const indicator = await buildIndicator({ ping: jest.fn().mockResolvedValue(undefined) });
    await expect(indicator.isHealthy('storage')).resolves.toEqual({ storage: { status: 'up' } });
  });

  it('uses the provided key', async () => {
    const indicator = await buildIndicator({ ping: jest.fn().mockResolvedValue(undefined) });
    await expect(indicator.isHealthy('object-store')).resolves.toEqual({ 'object-store': { status: 'up' } });
  });

  it('reports up "not configured" when StorageService is unbound', async () => {
    const indicator = await buildIndicator(null);
    await expect(indicator.isHealthy('storage')).resolves.toEqual({
      storage: { status: 'up', message: 'not configured' },
    });
  });

  it('returns down with the error message when ping throws', async () => {
    const indicator = await buildIndicator({
      ping: jest.fn().mockRejectedValue(new StorageUnavailableError('volume gone', { retryable: true })),
    });
    await expect(indicator.isHealthy('storage')).resolves.toEqual({
      storage: { status: 'down', message: 'volume gone' },
    });
  });

  it('handles a non-Error rejection', async () => {
    const indicator = await buildIndicator({ ping: jest.fn().mockRejectedValue('boom') });
    await expect(indicator.isHealthy('storage')).resolves.toEqual({
      storage: { status: 'down', message: 'boom' },
    });
  });

  it('does not throw — returns the down result for the aggregator', async () => {
    const indicator = await buildIndicator({ ping: jest.fn().mockRejectedValue(new Error('x')) });
    await expect(indicator.isHealthy()).resolves.toBeDefined();
  });
});
