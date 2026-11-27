import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { encodeKeysetCursor } from '../pagination/keyset-cursor';
import { CappedCursorPaginationQueryDto } from './cursor-pagination-query.dto';
import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './pagination-query.dto';

// Mirror the GLOBAL ValidationPipe transformOptions from apps/api/src/main.ts:
// query-string values arrive as strings, and implicit conversion feeds the
// numeric validators, as in capped-pagination-query.dto.spec.ts.
const toDto = <T extends object>(Dto: new () => T, plain: Record<string, unknown>): T =>
  plainToInstance(Dto, plain, { enableImplicitConversion: true });

const errorsFor = async (Dto: new () => object, property: string, plain: Record<string, unknown>) =>
  (await validate(toDto(Dto, plain))).filter((e) => e.property === property);

describe('CappedCursorPaginationQueryDto (#1597)', () => {
  class ListQuery extends CappedCursorPaginationQueryDto() {}

  const position = { createdAt: new Date('2026-11-27T10:00:00.123Z'), id: 'n1' };

  describe('limit', () => {
    it('defaults pageSize to the shared default when limit is absent', () => {
      expect(toDto(ListQuery, {}).pageSize).toBe(DEFAULT_PAGE_SIZE);
    });

    it('resolves pageSize to limit when one is sent', () => {
      expect(toDto(ListQuery, { limit: '7' }).pageSize).toBe(7);
    });

    it('accepts the default cap exactly', async () => {
      expect(await errorsFor(ListQuery, 'limit', { limit: String(DEFAULT_MAX_PAGE_SIZE) })).toHaveLength(0);
    });

    it('rejects a limit above the cap', async () => {
      const errors = await errorsFor(ListQuery, 'limit', { limit: String(DEFAULT_MAX_PAGE_SIZE + 1) });

      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('max');
    });

    it('rejects a zero limit', async () => {
      const errors = await errorsFor(ListQuery, 'limit', { limit: '0' });

      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('isPositive');
    });

    it('rejects a fractional limit', async () => {
      const errors = await errorsFor(ListQuery, 'limit', { limit: '2.5' });

      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('isInt');
    });

    it('lets a cap above the default stand, unclamped by the base', async () => {
      class ListAt200 extends CappedCursorPaginationQueryDto(200) {}

      expect(await errorsFor(ListAt200, 'limit', { limit: '150' })).toHaveLength(0);
      expect((await errorsFor(ListAt200, 'limit', { limit: '201' }))[0].constraints).toHaveProperty('max');
    });

    it('resolves pageSize to the default the endpoint names', () => {
      class ListDefault20 extends CappedCursorPaginationQueryDto(100, 20) {}

      expect(toDto(ListDefault20, {}).pageSize).toBe(20);
    });

    it('refuses a default above its own cap when the class is built', () => {
      expect(() => CappedCursorPaginationQueryDto(10, 20)).toThrow(RangeError);
    });
  });

  describe('cursor', () => {
    it('accepts a cursor from a previous page and decodes it to a position', async () => {
      const dto = toDto(ListQuery, { cursor: encodeKeysetCursor(position) });

      expect(await validate(dto)).toHaveLength(0);
      expect(dto.position).toEqual(position);
    });

    it('leaves the cursor optional: absent is the first page, with no position', async () => {
      const dto = toDto(ListQuery, {});

      expect(await validate(dto)).toHaveLength(0);
      expect(dto.position).toBeUndefined();
    });

    // #564: a JSON frame can send null past `@IsOptional`; it is the first
    // page, as an absent cursor is, rather than a throw in the getter.
    it('treats a null cursor as absent', async () => {
      const dto = toDto(ListQuery, { cursor: null });

      expect(await validate(dto)).toHaveLength(0);
      expect(dto.position).toBeUndefined();
    });

    // A garbage cursor is the caller's mistake, so it must be a 400 naming
    // `cursor`, never a 500 out of the query that would have read it.
    it.each([
      ['an empty cursor', ''],
      ['a cursor that is not one', 'garbage'],
      ['a 10 KB cursor', 'A'.repeat(10_000)],
    ])('rejects %s with the catalog key for a cursor', async (_label, cursor) => {
      const errors = await errorsFor(ListQuery, 'cursor', { cursor });

      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('keysetCursor');
      expect(errors[0].constraints?.keysetCursor.split('|')[0]).toBe('validation.isCursor');
    });

    // `?cursor=a&cursor=b` reaches the pipe as an array. Both constraints fail
    // on purpose: it is not a string, and it is not a cursor either.
    it('rejects a repeated cursor as neither a string nor a cursor', async () => {
      const errors = await errorsFor(ListQuery, 'cursor', { cursor: ['a', 'b'] });

      expect(errors).toHaveLength(1);
      expect(Object.keys(errors[0].constraints ?? {}).sort()).toEqual(['isString', 'keysetCursor']);
    });
  });

  // `pageSize` and `position` are getters with no setter: class-transformer
  // would throw "Cannot set property" (a 500) if it wrote a crafted parameter
  // onto either, and neither may steer the page.
  it('ignores a crafted pageSize or position parameter instead of failing on it', async () => {
    const dto = toDto(ListQuery, { limit: '10', pageSize: '99', position: 'x' });

    expect(dto.pageSize).toBe(10);
    expect(dto.position).toBeUndefined();
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });

  // The cursor replaces page-based paging on this contract, so a stale
  // `?page=` is a loud 400 under the global pipe's forbidNonWhitelisted.
  it('rejects a page parameter rather than ignoring it', async () => {
    const errors = await validate(toDto(ListQuery, { page: '2' }), { whitelist: true, forbidNonWhitelisted: true });

    expect(errors.map((error) => error.property)).toEqual(['page']);
  });
});
