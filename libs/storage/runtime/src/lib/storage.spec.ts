import { storage } from './storage.js';

describe('storage', () => {
  it('should work', () => {
    expect(storage()).toEqual('storage');
  });
});
