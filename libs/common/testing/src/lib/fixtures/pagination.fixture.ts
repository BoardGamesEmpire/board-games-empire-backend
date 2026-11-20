import type { PaginationQueryDto } from '@bge/shared';
import { DefaultPaginationQueryDto } from '@bge/shared';
import type { ClassConstructor } from 'class-transformer';
import { plainToInstance } from 'class-transformer';

/**
 * The fields a test may set on a page-based query DTO: every input it
 * declares, but not the derived `pageSize` and `skip`. Typed against the DTO,
 * so a misspelled key or a value outside a field's type fails to compile
 * rather than reaching the code under test unvalidated.
 */
export type PageQueryInit<T extends PaginationQueryDto> = Partial<Omit<T, 'pageSize' | 'skip'>>;

/**
 * A bound page-based query of any DTO class, as the global ValidationPipe
 * would hand one to a controller, so the class's own defaults apply. For a
 * query that extends the page contract with fields of its own (#959).
 */
export const boundPageQuery = <T extends PaginationQueryDto>(
  type: ClassConstructor<T>,
  init: PageQueryInit<T> = {},
): T => plainToInstance(type, init, { enableImplicitConversion: true });

/**
 * A bound pagination query, as the global ValidationPipe would hand one to a
 * controller. Tests need this rather than an object literal because the DTO's
 * `pageSize` and `skip` are derived accessors — a literal cannot satisfy the
 * type, and hand-writing the derived values is how a test ends up asserting
 * paging arithmetic that the DTO does not actually perform (#230).
 */
export const paginationQuery = (init: { limit?: number; page?: number } = {}): PaginationQueryDto =>
  boundPageQuery(DefaultPaginationQueryDto, init);
