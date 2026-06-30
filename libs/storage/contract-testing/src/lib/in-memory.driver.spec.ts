import { InsufficientStorageError, StorageUnavailableError } from '@boardgamesempire/storage-contract';
import { Buffer } from 'node:buffer';
import { InMemoryStorageDriver } from './in-memory.driver.js';

describe('InMemoryStorageDriver fault injection', () => {
  let driver: InMemoryStorageDriver;
  const meta = { contentType: 'text/plain' } as const;

  beforeEach(() => {
    driver = new InMemoryStorageDriver();
  });

  it('throws the injected fault for the targeted method only', async () => {
    const fault = new InsufficientStorageError('disk full');
    driver.setFault('put', fault);
    await expect(driver.put('k', Buffer.from('x'), meta)).rejects.toBe(fault);

    driver.setFault('put', null);
    await driver.put('k', Buffer.from('x'), meta);
    await expect(driver.get('k')).resolves.toMatchObject({ metadata: { key: 'k' } });
  });

  it("'all' faults every I/O method", async () => {
    await driver.put('k', Buffer.from('x'), meta);
    const fault = new StorageUnavailableError('volume gone', { retryable: true });
    driver.setFault('all', fault);
    await expect(driver.get('k')).rejects.toBe(fault);
    await expect(driver.head('k')).rejects.toBe(fault);
    await expect(driver.delete('k')).rejects.toBe(fault);
    await expect(driver.list('')).rejects.toBe(fault);
  });

  it('a method-specific fault wins over the all fault', async () => {
    driver.setFault('all', new StorageUnavailableError('all', { retryable: true }));
    const head = new InsufficientStorageError('head-specific');
    driver.setFault('head', head);
    await expect(driver.head('k')).rejects.toBe(head);
    await expect(driver.get('k')).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('clearing a fault restores normal operation', async () => {
    driver.setFault('put', new InsufficientStorageError('x'));
    driver.setFault('put', null);
    await expect(driver.put('k', Buffer.from('x'), meta)).resolves.toMatchObject({ key: 'k' });
  });

  it('ping is faultable', async () => {
    await expect(driver.ping()).resolves.toBeUndefined();
    const fault = new StorageUnavailableError('down', { retryable: true });
    driver.setFault('ping', fault);
    await expect(driver.ping()).rejects.toBe(fault);
  });
});
