import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CappedPaginationQueryDto, DefaultPaginationQueryDto } from './capped-pagination-query.dto';
import { DEFAULT_MAX_OFFSET, DEFAULT_MAX_PAGE_SIZE } from './pagination-query.dto';

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
    expect(await errorsFor(DefaultPaginationQueryDto, 'limit', { limit: String(DEFAULT_MAX_PAGE_SIZE) })).toHaveLength(0);
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

  it('defaults offset to 0 when absent', async () => {
    const dto = plainToInstance(DefaultPaginationQueryDto, {}, { enableImplicitConversion: true }) as { offset: number };
    expect(dto.offset).toBe(0);
  });

  it('accepts the offset cap exactly', async () => {
    expect(await errorsFor(DefaultPaginationQueryDto, 'offset', { offset: String(DEFAULT_MAX_OFFSET) })).toHaveLength(0);
  });

  // Bounds the worst-case Prisma `skip` scan (a large offset is a self-DoS in a
  // second dimension). offset lives on the base and is inherited, never re-declared.
  it('rejects an offset above the cap (@Max)', async () => {
    const errors = await errorsFor(DefaultPaginationQueryDto, 'offset', { offset: String(DEFAULT_MAX_OFFSET + 1) });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('rejects a negative offset (@Min(0))', async () => {
    const errors = await errorsFor(DefaultPaginationQueryDto, 'offset', { offset: '-1' });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('min');
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

  it('inherits the base offset ceiling it does not re-declare', async () => {
    const errors = await errorsFor(ListAt200, 'offset', { offset: String(DEFAULT_MAX_OFFSET + 1) });
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });
});
