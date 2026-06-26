import { storageContract } from './storage-contract.js';

describe('storageContract', () => {
  it('should work', () => {
    expect(storageContract()).toEqual('storage-contract');
  });
});
