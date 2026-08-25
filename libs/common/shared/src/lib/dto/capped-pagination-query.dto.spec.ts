import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CappedOffsetPaginationQueryDto,
  CappedPaginationQueryDto,
  DefaultPaginationQueryDto,
} from './capped-pagination-query.dto';
import { DEFAULT_MAX_OFFSET, DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './pagination-query.dto';

// Mirror the GLOBAL ValidationPipe transformOptions from apps/api/src/main.ts:
// query-string values arrive as strings, so implicit conversion is what feeds
// the numeric validators. The tests must run with it on to be meaningful.
const errorsFor = async (Dto: new () => object, property: string, plain: Record<string, unknown>) =>
  (await validate(plainToInstance(Dto, plain, { enableImplicitConversion: true }))).filter(
    (e) => e.property === property,
  );

describe('DefaultPaginationQueryDto — the secure-by-default opt-out DTO', () => {
  it('accepts a limit within range', async () => {
    expect(await errorsFor(DefaultPaginationQueryDto, 'limit', { limit: '50' })).toHaveLength(0);
  });

  it('accepts the default cap exactly', async () => {
    expect(await errorsFor(DefaultPaginationQueryDto, 'limit', { limit: String(DEFAULT_MAX_PAGE_SIZE) })).toHaveLength(
      0,
    );
  });

  // #11: the base carried no cap, so /games, /households passed an arbitrary
  // limit straight to Prisma `take` — an authenticated self-DoS. The default
  // ceiling now bounds any endpoint that opts out of choosing its own.
  it('rejects a limit above the default cap (@Max)', async () => {
    const errors = await errorsFor(DefaultPaginationQueryDto, 'limit', { limit: String(DEFAULT_MAX_PAGE_SIZE + 1) });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('rejects a negative limit (@IsPositive survives the factory re-declaration)', async () => {
    const errors = await errorsFor(DefaultPaginationQueryDto, 'limit', { limit: '-50' });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isPositive');
  });

  it('rejects a zero limit (@IsPositive)', async () => {
    const errors = await errorsFor(DefaultPaginationQueryDto, 'limit', { limit: '0' });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isPositive');
  });

  it('leaves limit optional — absent is valid', async () => {
    expect(await errorsFor(DefaultPaginationQueryDto, 'limit', {})).toHaveLength(0);
  });

  it('defaults page to 1 when absent', async () => {
    const dto = plainToInstance(DefaultPaginationQueryDto, {}, { enableImplicitConversion: true });

    expect(dto.page).toBe(1);
  });

  // D-230-3: the resolved page size is a contract value, not a per-service
  // fallback — `skip` is derived from it, so a service-local default would make
  // the echoed limit disagree with the rows sent.
  it('resolves pageSize to the shared default when limit is absent', async () => {
    const dto = plainToInstance(DefaultPaginationQueryDto, {}, { enableImplicitConversion: true });

    expect(dto.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(dto.skip).toBe(0);
  });

  it('derives skip from (page - 1) x limit', async () => {
    const dto = plainToInstance(
      DefaultPaginationQueryDto,
      { page: '4', limit: '20' },
      { enableImplicitConversion: true },
    );

    expect(dto.pageSize).toBe(20);
    expect(dto.skip).toBe(60);
  });

  it('rejects page 0 and negative pages (@Min(1) — pages are 1-based)', async () => {
    expect((await errorsFor(DefaultPaginationQueryDto, 'page', { page: '0' }))[0].constraints).toHaveProperty('min');
    expect((await errorsFor(DefaultPaginationQueryDto, 'page', { page: '-1' }))[0].constraints).toHaveProperty('min');
  });

  it('rejects a fractional page (@IsInt)', async () => {
    const errors = await errorsFor(DefaultPaginationQueryDto, 'page', { page: '1.5' });

    expect(errors[0].constraints).toHaveProperty('isInt');
  });

  it('leaves page optional — absent is valid', async () => {
    expect(await errorsFor(DefaultPaginationQueryDto, 'page', {})).toHaveLength(0);
  });

  // D-230-4: the ceiling is on the DERIVED skip, so how deep a caller may page
  // scales with the page size instead of being a flat page-number wall. A large
  // public games instance pages through thousands of rows legitimately.
  it('accepts the deepest page that lands exactly on the skip ceiling', async () => {
    const page = String(DEFAULT_MAX_OFFSET / 100 + 1);

    expect(await errorsFor(DefaultPaginationQueryDto, 'page', { page, limit: '100' })).toHaveLength(0);
  });

  it('rejects a page whose derived skip passes the ceiling', async () => {
    const page = String(DEFAULT_MAX_OFFSET / 100 + 2);
    const errors = await errorsFor(DefaultPaginationQueryDto, 'page', { page, limit: '100' });

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('skipWithinCeiling');
  });

  it('lets a bigger page size reach further, since the ceiling bounds rows scanned, not pages', async () => {
    const atSmallPageSize = await errorsFor(DefaultPaginationQueryDto, 'page', { page: '5000', limit: '1' });
    const atLargePageSize = await errorsFor(DefaultPaginationQueryDto, 'page', { page: '5000', limit: '100' });

    expect(atSmallPageSize).toHaveLength(0);
    expect(atLargePageSize).toHaveLength(1);
  });

  // `pageSize`/`skip` are getters with no setter, so class-transformer would
  // throw "Cannot set property" — a 500 out of the ValidationPipe — the moment a
  // caller sent `?pageSize=`. `@Exclude()` keeps the transformer off them, and
  // the crafted parameter cannot influence the page either.
  it('ignores a crafted pageSize or skip parameter instead of failing on it', async () => {
    const dto = plainToInstance(
      DefaultPaginationQueryDto,
      { page: '2', limit: '10', pageSize: '99', skip: '9999' },
      { enableImplicitConversion: true },
    );

    expect(dto.pageSize).toBe(10);
    expect(dto.skip).toBe(10);
  });

  // The depth check reads `limit`, so a non-numeric one would otherwise fail it
  // too and answer a question the caller never asked: the error belongs to
  // `limit`, and piling a "page is too deep" on top of it misdirects the fix.
  it('reports only the limit error when limit is not a number', async () => {
    const errors = await validate(
      plainToInstance(DefaultPaginationQueryDto, { page: '2', limit: 'abc' }, { enableImplicitConversion: true }),
      { whitelist: true, forbidNonWhitelisted: true },
    );

    expect(errors.map((error) => error.property)).toEqual(['limit']);
  });

  it('does not add a depth failure when page itself is not a number', async () => {
    const errors = await errorsFor(DefaultPaginationQueryDto, 'page', { page: 'abc' });

    expect(errors[0].constraints).toHaveProperty('isInt');
    expect(errors[0].constraints).not.toHaveProperty('skipWithinCeiling');
  });

  // The page-based contract replaced offset (D-230-1). `offset` is no longer a
  // declared property, so the global pipe's forbidNonWhitelisted turns a stale
  // `?offset=40` into a loud 400 instead of ignoring it silently.
  it('rejects a stale offset parameter rather than ignoring it', async () => {
    const dto = plainToInstance(DefaultPaginationQueryDto, { offset: '40' }, { enableImplicitConversion: true });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors.map((error) => error.property)).toContain('offset');
  });
});

describe('CappedPaginationQueryDto — each endpoint owns its ceiling', () => {
  // A feature DTO adds a filter but does NOT re-declare limit — the real shape
  // of ListAuditLogsQueryDto / list-game-collections. The factory's @Max must
  // survive as the sole limit-cap declarer; nothing clamps it to a base default.
  class ListAt200 extends CappedPaginationQueryDto(200) {
    foo?: string;
  }
  class ListAt50 extends CappedPaginationQueryDto(50) {}
  // Mirrors LanguageQueryDto etc.: a feature DTO extending the shared default.
  class ExtendsDefault extends DefaultPaginationQueryDto {
    bar?: string;
  }

  it('a cap above the default (audit-log at 200) is NOT clamped to the default', async () => {
    expect(await errorsFor(ListAt200, 'limit', { limit: '150' })).toHaveLength(0);
    expect(await errorsFor(ListAt200, 'limit', { limit: '200' })).toHaveLength(0);
  });

  it('rejects a limit above the endpoint cap (200)', async () => {
    const errors = await errorsFor(ListAt200, 'limit', { limit: '201' });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('a tighter cap (50) rejects above itself', async () => {
    const errors = await errorsFor(ListAt50, 'limit', { limit: '75' });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('a feature DTO extending the shared default inherits the 100 cap', async () => {
    expect(await errorsFor(ExtendsDefault, 'limit', { limit: '100' })).toHaveLength(0);
    const errors = await errorsFor(ExtendsDefault, 'limit', { limit: '101' });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('still rejects a negative limit at a custom cap (@IsPositive)', async () => {
    const errors = await errorsFor(ListAt200, 'limit', { limit: '-1' });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isPositive');
  });

  it('inherits the base skip ceiling it does not re-declare', async () => {
    const errors = await errorsFor(ListAt200, 'page', { page: String(DEFAULT_MAX_OFFSET), limit: '200' });

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('skipWithinCeiling');
  });
});

// D-230-5: the gateway search fan-out stays offset-native, because its proto
// contract and the upstream vendor APIs are. Same limit-cap hardening, but the
// client input is `offset` rather than `page`.
describe('CappedOffsetPaginationQueryDto — the offset-native transport DTO', () => {
  class SearchAt100 extends CappedOffsetPaginationQueryDto(100) {}

  it('defaults offset to 0 when absent', async () => {
    const dto = plainToInstance(SearchAt100, {}, { enableImplicitConversion: true });

    expect(dto.offset).toBe(0);
  });

  it('accepts the offset cap exactly', async () => {
    expect(await errorsFor(SearchAt100, 'offset', { offset: String(DEFAULT_MAX_OFFSET) })).toHaveLength(0);
  });

  it('rejects an offset above the cap (@Max)', async () => {
    const errors = await errorsFor(SearchAt100, 'offset', { offset: String(DEFAULT_MAX_OFFSET + 1) });

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('rejects a negative offset (@Min(0))', async () => {
    const errors = await errorsFor(SearchAt100, 'offset', { offset: '-1' });

    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('min');
  });

  it('still caps limit, and does not accept a page parameter', async () => {
    const errors = await errorsFor(SearchAt100, 'limit', { limit: '101' });
    const dto = plainToInstance(SearchAt100, { page: '3' }, { enableImplicitConversion: true });
    const whitelisted = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors[0].constraints).toHaveProperty('max');
    expect(whitelisted.map((error) => error.property)).toContain('page');
  });
});
