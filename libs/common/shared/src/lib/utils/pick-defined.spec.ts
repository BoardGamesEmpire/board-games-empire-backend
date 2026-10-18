import { pickDefined } from './pick-defined';

describe('pickDefined', () => {
  it('drops the keys that are present but undefined', () => {
    expect(pickDefined({ name: 'Den', description: undefined })).toEqual({ name: 'Den' });
  });

  it('keeps null, which is a value rather than "not provided"', () => {
    expect(pickDefined({ description: null })).toEqual({ description: null });
  });

  it('leaves its input untouched', () => {
    const patch = { name: undefined };

    pickDefined(patch);

    expect(patch).toHaveProperty('name');
  });
});
