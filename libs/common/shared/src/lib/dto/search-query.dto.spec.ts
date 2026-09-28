import { validate } from 'class-validator';
import { SearchQueryDto } from './search-query.dto';

describe('SearchQueryDto', () => {
  // Assigned without the transformer: implicit conversion would turn a number
  // into a string before `@IsString` saw it. The key is the part of the
  // `key|{…}` marker before the first `|`; `@bge/testing`'s helper is out of
  // reach here, because that lib depends on this one.
  it('names a catalog key for every q failure', async () => {
    const [error] = await validate(Object.assign(new SearchQueryDto(), { q: 7 }));

    expect(error.property).toBe('q');
    expect(
      Object.fromEntries(
        Object.entries(error.constraints ?? {}).map(([constraint, message]) => [constraint, message.split('|')[0]]),
      ),
    ).toEqual({ isString: 'validation.isString', minLength: 'validation.minLength' });
  });
});
