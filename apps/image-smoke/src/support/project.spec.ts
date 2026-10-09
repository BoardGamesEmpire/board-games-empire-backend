import { smokeProject } from './project';

describe('smokeProject', () => {
  it("takes the suite's own project when none is named", () => {
    expect(smokeProject(undefined)).toBe('bge-image-smoke');
    expect(smokeProject('')).toBe('bge-image-smoke');
  });

  it('takes another project of its own, to run beside the first', () => {
    expect(smokeProject('bge-image-smoke-2')).toBe('bge-image-smoke-2');
  });

  // A run removes its project's containers and volumes before it starts, and
  // the run's files after them.
  it.each([
    ['the project compose.yaml runs as', 'bge'],
    ['a name that only starts as its own does', 'bge-image-smokey'],
    ['a path out of the output directory', 'bge-image-smoke-2/../../..'],
  ])('refuses %s', (_, named) => {
    expect(() => smokeProject(named)).toThrow(`BGE_SMOKE_PROJECT=${named}`);
  });
});
