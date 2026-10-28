import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListGamesQueryDto } from './list-games.query.dto';

/**
 * `sort` names an order for `GET /games`. It reorders the list and never
 * narrows the set (#959).
 */
describe('ListGamesQueryDto', () => {
  // Mirror the global ValidationPipe transform (query-string values arrive as
  // strings), matching the CappedPaginationQueryDto spec.
  const toDto = (plain: Record<string, unknown>): ListGamesQueryDto =>
    plainToInstance(ListGamesQueryDto, plain, { enableImplicitConversion: true });

  const errorsFor = async (property: string, plain: Record<string, unknown>) =>
    (await validate(toDto(plain))).filter((e) => e.property === property);

  it('defaults to title order when sort is left out', async () => {
    const dto = toDto({});
    expect(dto.sort).toBe('title');
    expect(await errorsFor('sort', {})).toHaveLength(0);
  });

  it.each(['title', 'newest'])('accepts %s', async (sort) => {
    expect(await errorsFor('sort', { sort })).toHaveLength(0);
  });

  // #959: a sort the server doesn't know is refused, not read as the default.
  it.each([
    ['an unknown order', 'oldest'],
    ['a different case', 'Newest'],
    ['an empty value', ''],
    ['a repeated parameter', ['newest', 'title']],
  ])('refuses %s with isIn', async (_label, sort) => {
    const errors = await errorsFor('sort', { sort });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isIn');
  });

  it('names the validation catalog key for a refused sort', async () => {
    expect(validationCatalogKeys(await validate(plainToInstance(ListGamesQueryDto, { sort: 'oldest' })))).toEqual({
      'sort.isIn': 'validation.isIn',
    });
  });

  it('keeps the page contract it extends', async () => {
    const dto = toDto({ page: '2', limit: '10', sort: 'newest' });
    expect([dto.page, dto.pageSize, dto.skip, dto.sort]).toEqual([2, 10, 10, 'newest']);
  });
});
