import { InMemoryStorageDriver } from './in-memory.driver.js';
import { runStorageDriverContract } from './run-storage-driver-contract.js';

describe('InMemoryStorageDriver', () => {
  runStorageDriverContract(() => ({ driver: new InMemoryStorageDriver() }));
});
