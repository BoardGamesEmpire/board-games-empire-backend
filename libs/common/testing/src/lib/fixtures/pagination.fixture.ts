import { DefaultPaginationQueryDto, PaginationQueryDto } from '@bge/shared';
import { plainToInstance } from 'class-transformer';

/**
 * A bound pagination query, as the global ValidationPipe would hand one to a
 * controller. Tests need this rather than an object literal because the DTO's
 * `pageSize` and `skip` are derived accessors — a literal cannot satisfy the
 * type, and hand-writing the derived values is how a test ends up asserting
 * paging arithmetic that the DTO does not actually perform (#230).
 */
export const paginationQuery = (init: { page?: number; limit?: number } = {}): PaginationQueryDto =>
  plainToInstance(DefaultPaginationQueryDto, init, { enableImplicitConversion: true });
